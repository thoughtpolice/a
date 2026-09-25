#!/bin/bash
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
#
# Load a minimos-based OCI image into the local docker daemon, boot it
# under systemd, wait for `systemctl is-system-running` to settle, and
# assert:
#   - state is "running" (not "degraded", "initializing", "maintenance")
#   - zero failed units
#   - a minimum set of running services (dbus, journald, logind), plus
#     any extra units passed as arguments
#   - no distro userspace beyond the deliberate exe.dev login shells
#   - no setuid/setgid or world-writable (sans sticky) entries in any layer
#   - /etc/{passwd,group,shadow} don't drift from the baked copies at boot
#   - a warning-free boot journal
#
# Expects docker to be available on the host. Test fails if it isn't —
# this is a dev-machine smoke test, not a hermetic unit test.
#
# Usage: boot_smoke.sh SKOPEO SCRATCH_IMAGE OCI_LAYOUT --image-cmd CSV
#        [--base-layer-count N] [--policy FILE]
#        [--userland] [--dev] [--containers] [EXTRA_UNIT...]
#
# --userland: the image deliberately ships an interactive userland
# (coreutils, extra shells) — skip the no-distro-userspace layer check.
# Package managers stay banned, and so do the suid/world-writable and
# account-drift checks: those are invariants for dev images too.
#
# --containers: the image is a container host — additionally assert that
# gVisor is the only OCI runtime present and that containerd came up with
# it configured as the default.

set -euo pipefail

SKOPEO="${1:?skopeo binary}"
VALIDATOR="${2:?scratch_image binary}"
OCI_LAYOUT="${3:?oci image layout dir}"
shift 3
USERLAND=0
DEV=0
CONTAINERS=0
IMAGE_CMD_CSV=""
BASE_LAYER_COUNT=0
POLICY=""
while [[ "${1:-}" == --* ]]; do
    case "$1" in
        --userland) USERLAND=1 ;;
        --dev) DEV=1 ;;
        --containers) CONTAINERS=1 ;;
        --image-cmd)
            shift
            IMAGE_CMD_CSV="${1:?--image-cmd needs a comma-separated argv}"
            ;;
        --base-layer-count)
            shift
            BASE_LAYER_COUNT="${1:?--base-layer-count needs an integer}"
            ;;
        --policy)
            shift
            POLICY="${1:?--policy needs a file}"
            ;;
        *) echo "boot_smoke: unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done
EXTRA_UNITS=("$@")
if [[ -z "$IMAGE_CMD_CSV" ]]; then
    echo "boot_smoke: --image-cmd is required" >&2
    exit 2
fi
IFS=',' read -r -a IMAGE_CMD <<<"$IMAGE_CMD_CSV"

TAG="minimos-boot-smoke:$(date +%s)-$$"
CID=""
WORK_DIR=$(mktemp -d -p /tmp minimos-boot-smoke.XXXXXX)
CID_FILE="$WORK_DIR/cid"

cleanup() {
    if [[ -z "$CID" && -s "$CID_FILE" ]]; then
        CID=$(<"$CID_FILE")
    fi
    if [[ -n "$CID" ]]; then
        timeout --signal=KILL 15s docker rm -f -- "$CID" >/dev/null 2>&1 || true
    fi
    timeout --signal=KILL 15s docker rmi -- "$TAG" >/dev/null 2>&1 || true
    rm -f -- "$CID_FILE"
    rmdir -- "$WORK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
    echo "boot_smoke: docker not available; cannot run this test" >&2
    exit 1
fi
if ! command -v timeout >/dev/null 2>&1; then
    echo "boot_smoke: timeout not available; refusing an unbounded host test" >&2
    exit 1
fi

# Verify descriptor linkage/digests and reject unsafe metadata in every
# manifest-referenced layer before loading or executing anything. The content
# scan below then adds appliance/package policy checks.
VALIDATOR_ARGS=(
    validate "$OCI_LAYOUT"
    --expected-cmd "$IMAGE_CMD_CSV"
    --base-layer-count "$BASE_LAYER_COUNT"
)
if [[ -n "$POLICY" ]]; then
    VALIDATOR_ARGS+=(--policy "$POLICY")
fi
timeout --signal=KILL 30s "$VALIDATOR" "${VALIDATOR_ARGS[@]}"

# Every directory a binary on the image's PATH can live in.
BIN='^(\./)?(usr/)?(local/)?(bin|sbin)/'
BANNED_USERLAND="${BIN}(zsh|ash|fish|ksh|csh|tcsh|busybox|ls|cat|cp|rm)\$"
BANNED_ALWAYS="${BIN}(apt|apt-get|dpkg|snap|apk|dnf|microdnf|yum|rpm|pacman|zypper|nix|nix-env|guix)\$"
# A container host runs its workloads under gVisor because gVisor is the
# only thing in the image that can start a container at all. That is an
# image-content property, so check it against the built layers: a runc,
# crun, or runc shim arriving through some package's dependency tail
# would turn "sandboxed" back into "sandboxed by configuration".
BANNED_RUNTIMES="${BIN}(runc|crun|youki|containerd-shim-runc-v[0-9]+)\$"
GVISOR_RUNTIME="${BIN}(runsc|containerd-shim-runsc-v1)\$"
GVISOR_FOUND=""
CHRONY_STATE=""
for blob in "$OCI_LAYOUT"/blobs/sha256/*; do
    [[ -f "$blob" ]] || continue
    set +e
    listing=$(timeout --signal=KILL 10s tar -tf "$blob" 2>/dev/null)
    tar_status=$?
    set -e
    if [[ "$tar_status" -eq 124 || "$tar_status" -eq 137 ]]; then
        echo "boot_smoke: FAIL — timed out inspecting image blob $blob" >&2
        exit 1
    fi
    # OCI manifests and configs are JSON blobs rather than tar archives.
    # Layer metadata has already passed scratch_image.py's mandatory parser;
    # only tar-readable blobs participate in this independent content scan.
    [[ "$tar_status" -eq 0 ]] || continue
    if [[ "$USERLAND" -eq 0 ]] && grep -qE "$BANNED_USERLAND" <<<"$listing"; then
        echo "boot_smoke: FAIL — distro userspace present in an image layer:" >&2
        grep -E "$BANNED_USERLAND" <<<"$listing" >&2
        exit 1
    fi
    if grep -qE "$BANNED_ALWAYS" <<<"$listing"; then
        echo "boot_smoke: FAIL — package manager present in an image layer:" >&2
        grep -E "$BANNED_ALWAYS" <<<"$listing" >&2
        exit 1
    fi
    if [[ "$CONTAINERS" -eq 1 ]]; then
        if grep -qE "$BANNED_RUNTIMES" <<<"$listing"; then
            echo "boot_smoke: FAIL — an OCI runtime other than gVisor is present in an image layer:" >&2
            grep -E "$BANNED_RUNTIMES" <<<"$listing" >&2
            exit 1
        fi
        GVISOR_FOUND+=$'\n'$(grep -E "$GVISOR_RUNTIME" <<<"$listing" || true)
    fi
    set +e
    verbose=$(timeout --signal=KILL 10s tar -tvf "$blob" 2>/dev/null)
    tar_status=$?
    set -e
    if [[ "$tar_status" -ne 0 ]]; then
        echo "boot_smoke: FAIL — layer became unreadable during metadata inspection: $blob" >&2
        exit 1
    fi
    suid=$(awk '$1 !~ /^l/ && (substr($1,4,1) ~ /[sS]/ || substr($1,7,1) ~ /[sS]/)' <<<"$verbose")
    if [[ -n "$suid" ]]; then
        echo "boot_smoke: FAIL — setuid/setgid entries in an image layer:" >&2
        echo "$suid" >&2
        exit 1
    fi
    CHRONY_STATE+=$'\n'$(awk '$NF ~ /^(\.\/)?var\/lib\/chrony\/?$/' <<<"$verbose" || true)
    ww=$(awk '$1 !~ /^l/ && substr($1,9,1) == "w" && !($1 ~ /^d/ && substr($1,10,1) ~ /[tT]/)' <<<"$verbose")
    if [[ -n "$ww" ]]; then
        echo "boot_smoke: FAIL — world-writable entries in an image layer:" >&2
        echo "$ww" >&2
        exit 1
    fi
done

echo "boot_smoke: loading $OCI_LAYOUT into docker as $TAG"
timeout --signal=KILL 90s "$SKOPEO" --insecure-policy copy \
    "oci:$OCI_LAYOUT:latest" "docker-daemon:$TAG"

echo "boot_smoke: running systemd with a private cgroup namespace and bounded capabilities"
# Boot the image's baked Cmd (the flags minimos.image sets) on a pty, so
# the --show-status stream lands in `docker logs` the same way it lands
# on the exe.dev VM console. systemd's own log messages go to the
# journal (--log-target=syslog); on failure we dump them from there.
#
# AppArmor is the one outer layer PID 1 cannot run under. docker-default
# denies mount propagation changes, and systemd forks its generators into
# a private mount namespace whose first act is making / MS_SLAVE. That
# fails inside the child, which the manager only sees as an exit status
# (EPROTO), so its fallback for privilege errors never fires and PID 1
# exits. Seccomp, the capability bound, and no-new-privileges stay on; on
# hosts without AppArmor this option changes nothing.
RUN_OUTPUT=""
if ! RUN_OUTPUT=$(timeout --signal=KILL 30s docker run -d -t \
    --cidfile "$CID_FILE" \
    --label dev.exe.minimos.boot-smoke=true \
    --cgroupns private \
    --network none \
    --memory 1g \
    --memory-swap 1g \
    --cpus 2 \
    --pids-limit 1024 \
    --ulimit core=0:0 \
    --log-driver local \
    --log-opt max-size=2m \
    --log-opt max-file=2 \
    --security-opt no-new-privileges=true \
    --security-opt apparmor=unconfined \
    --cap-drop ALL \
    --cap-add AUDIT_WRITE \
    --cap-add CHOWN \
    --cap-add DAC_OVERRIDE \
    --cap-add FOWNER \
    --cap-add FSETID \
    --cap-add KILL \
    --cap-add MKNOD \
    --cap-add NET_BIND_SERVICE \
    --cap-add SETFCAP \
    --cap-add SETGID \
    --cap-add SETPCAP \
    --cap-add SETUID \
    --cap-add SYS_ADMIN \
    --cap-add SYS_CHROOT \
    --tmpfs /run:rw,nosuid,nodev,mode=755,size=64m \
    --tmpfs /run/lock:rw,nosuid,nodev,noexec,mode=755,size=8m \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,mode=1777,size=128m \
    --entrypoint /usr/lib/minimos/docker-boot-wrapper \
    "$TAG" "${IMAGE_CMD[@]}" \
    2>&1); then
    echo "boot_smoke: docker failed to start the bounded container: $RUN_OUTPUT" >&2
    exit 1
fi
CID=$(<"$CID_FILE")
if [[ ! "$CID" =~ ^[0-9a-f]{12,64}$ ]]; then
    echo "boot_smoke: docker returned an invalid container ID: $CID" >&2
    exit 1
fi
echo "boot_smoke: container $CID"

docker_exec() {
    timeout --signal=KILL 10s docker exec "$CID" "$@"
}

DEADLINE=$(( $(date +%s) + 45 ))
STATE="(never started)"
while [[ "$(date +%s)" -lt "$DEADLINE" ]]; do
    STATE=$(docker_exec /usr/bin/systemctl is-system-running 2>&1 || true)
    case "$STATE" in
        running|degraded) break ;;
    esac
    if [[ "$(timeout --signal=KILL 5s docker inspect --format '{{.State.Running}}' "$CID" 2>/dev/null || true)" != "true" ]]; then
        STATE="container-exited"
        break
    fi
    sleep 1
done

echo "boot_smoke: final systemctl is-system-running -> $STATE"

if [[ "$STATE" != "running" ]]; then
    echo "boot_smoke: FAIL — system not running (state=$STATE)" >&2
    echo "=== failed units ==="
    docker_exec /usr/bin/systemctl --no-pager list-units --state=failed || true
    echo "=== recent journal ==="
    docker_exec /usr/bin/journalctl --no-pager -n 50 || true
    echo "=== bounded console ==="
    timeout --signal=KILL 10s docker logs --tail 200 "$CID" || true
    exit 1
fi

FAILED=$(docker_exec /usr/bin/systemctl --no-pager --no-legend list-units --state=failed 2>&1 | wc -l)
if [[ "$FAILED" -gt 0 ]]; then
    echo "boot_smoke: FAIL — $FAILED unit(s) in failed state" >&2
    docker_exec /usr/bin/systemctl --no-pager list-units --state=failed
    exit 1
fi

# Assert the expected minimum running set, plus whatever the image under
# test adds (e.g. nginx.service for the nginx composition).
EXPECTED=(dbus.service systemd-journald.service systemd-logind.service)
for unit in "${EXPECTED[@]}" "${EXTRA_UNITS[@]}"; do
    if ! docker_exec /usr/bin/systemctl is-active --quiet "$unit"; then
        echo "boot_smoke: FAIL — required service $unit is not active" >&2
        docker_exec /usr/bin/systemctl status --no-pager "$unit" || true
        exit 1
    fi
done

# user-workload.slice inherits systemd's generic user-.slice.d drop-ins.
# Assert the realized value so a vendor default cannot silently replace the
# fixed host-safety ceiling.
WORKLOAD_TASKS_MAX=$(docker_exec /usr/bin/systemctl show \
    user-workload.slice --property=TasksMax --value 2>&1)
if [[ "$WORKLOAD_TASKS_MAX" != "2048" ]]; then
    echo "boot_smoke: FAIL — user-workload.slice TasksMax=$WORKLOAD_TASKS_MAX, expected 2048" >&2
    docker_exec /usr/bin/systemctl cat user-workload.slice >&2 || true
    exit 1
fi

# Weight-based block-I/O scheduling is optional in the kernel. The aggregate
# user ceiling uses io.max instead, which must be realized on the root
# filesystem's backing device. Appliance images have no cat, so bash reads
# the file.
USER_IO_MAX=""
if USER_IO_MAX=$(docker_exec /usr/bin/bash -c 'printf "%s" "$(</sys/fs/cgroup/user.slice/io.max)"' 2>/dev/null) &&
        [[ -n "$USER_IO_MAX" ]]; then
    for io_limit in rbps=500000000 wbps=250000000 riops=50000 wiops=25000; do
        if ! grep -Eq "(^|[[:space:]])${io_limit}([[:space:]]|$)" <<<"$USER_IO_MAX"; then
            echo "boot_smoke: FAIL — user.slice io.max lacks $io_limit: $USER_IO_MAX" >&2
            exit 1
        fi
    done
else
    # Docker's overlay-backed root cannot always be resolved to an originating
    # block device from this private cgroup namespace. The real-VM integration
    # check must assert the nonempty, exact io.max policy.
    echo "boot_smoke: Docker does not expose a resolvable backing device; deferring io.max realization to the VM test"
fi

# A minimos boot is warning-free, and that is an assertion rather than an
# aspiration. Two classes of real defect show up here and nowhere else: a
# hardening directive silently ignored by a manager that still reports the
# unit "active", and a vendor config referencing an account, device, or path
# the baked image does not have. Both otherwise leave the boot "successful".
#
# Every tolerated line is listed below, anchored whole, with the reason it is
# not a defect. Nothing is matched by substring: a new warning that merely
# resembles one of these still fails the test.
#
#   block device — harness-only, and confirmed so on a real VM: docker's
#     overlay root has no originating block device, so PID 1 cannot resolve
#     user.slice's io.max. Same root cause as the deferred io.max realization
#     check above. An exe.dev VM's virtio root resolves it and programs the
#     exact rbps/wbps/riops/wiops values.
#   io pressure — NOT a harness artifact; it appears on a real VM too. The
#     user manager arms a PSI trigger and the kernel allows only one per file
#     descriptor, so a re-arm returns EBUSY and systemd says "ignoring". The
#     io controller itself is present and delegated all the way down to
#     user@1000.service — verified on a VM — so nothing is silently disabled.
#   libbpf / kmod — deliberate: two optional libraries this image does not
#     ship. libbpf gates SocketBind*=, RestrictNetworkInterfaces= and
#     RestrictFileSystems=, none of which minimos uses (and the platform
#     kernel has no BPF LSM for the last one). IPAddressDeny=/IPAddressAllow=
#     do NOT go through it — they use raw bpf() syscalls, and were verified
#     enforcing: a loopback connect is refused under IPAddressDeny=any and
#     permitted once IPAddressAllow=localhost is added. libkmod is absent
#     because module loading is latched off; that line appears only on a VM,
#     since PID 1 skips module setup in a container.
BOOT_WARNINGS=$(docker_exec /usr/bin/journalctl -b -p warning --no-pager -o cat 2>&1 | \
    grep -vEe '^$' \
         -e "^'/' is not a block device node, and file system block device cannot be determined or is not local\.$" \
         -e '^Failed to adjust io pressure threshold, ignoring: Device or resource busy$' \
         -e '^Neither libbpf\.so\.[0-9]+ nor libbpf\.so\.[0-9]+ are installed, cgroup BPF features disabled\.$' \
         -e '^Failed to initialize kmod context: Operation not supported$' \
    || true)
if [[ -n "$BOOT_WARNINGS" ]]; then
    echo "boot_smoke: FAIL — boot is not warning-clean:" >&2
    echo "$BOOT_WARNINGS" >&2
    exit 1
fi

# Console contract: the boot status stream must be present (this is
# exactly what `ssh exe.dev vm-logs` shows) and free of ANSI escapes —
# minimos.image passes --show-status=true --log-color=false to systemd.
CONSOLE=$(timeout --signal=KILL 10s docker logs --tail 400 "$CID" 2>&1)
if ! grep -q '\[  OK  \]' <<<"$CONSOLE"; then
    echo "boot_smoke: FAIL — no '[  OK  ]' status lines on the boot console" >&2
    exit 1
fi
if grep -q $'\x1b' <<<"$CONSOLE"; then
    echo "boot_smoke: FAIL — ANSI escapes on the boot console (vm-logs must stay plain):" >&2
    grep -m 3 $'\x1b' <<<"$CONSOLE" | cat -v >&2
    exit 1
fi

# Account bake contract: exactly one layer ships each account file
# (the base overlay), and nothing rewrites them at runtime —
# systemd-sysusers is masked and its configs are culled, so a drift
# here means some new machinery started editing accounts at boot.
# bash's $(<file) is the coreutils-free read on the booted side.
for f in passwd group shadow; do
    baked=""
    found=0
    for blob in "$OCI_LAYOUT"/blobs/sha256/*; do
        [[ -f "$blob" ]] || continue
        if b=$(timeout --signal=KILL 10s tar -xOf "$blob" "etc/$f" 2>/dev/null); then
            baked="$b"
            found=$((found + 1))
        fi
    done
    if [[ "$found" -ne 1 ]]; then
        echo "boot_smoke: FAIL — etc/$f present in $found layers (must be exactly one, the base overlay)" >&2
        exit 1
    fi
    booted=$(docker_exec /usr/bin/bash -c "printf '%s' \"\$(</etc/$f)\"")
    if [[ "$booted" != "${baked%$'\n'}" ]]; then
        echo "boot_smoke: FAIL — /etc/$f drifted from the baked copy at runtime:" >&2
        diff <(printf '%s\n' "${baked%$'\n'}") <(printf '%s\n' "$booted") >&2 || true
        exit 1
    fi
done

# The single owner has to be able to read the system journal: it is the only
# way to investigate anything on an image with no shell tools and no root
# login. That rests on journald's files landing in the systemd-journal group,
# which journald does not arrange by itself — it creates the per-machine
# directory 0755 root:root, and tmpfiles has to correct it. Exercise the
# group, not the account, because `docker exec --user` does not resolve
# supplementary groups out of the image's /etc/group the way the platform
# sshd does.
JOURNAL_READ=$(timeout --signal=KILL 15s docker exec --user 1000:105 "$CID" \
    /usr/bin/journalctl -b -n 1 --no-pager -o cat 2>&1 || true)
if [[ -z "$JOURNAL_READ" || "$JOURNAL_READ" == *"insufficient permissions"* || "$JOURNAL_READ" == *"No journal files"* ]]; then
    echo "boot_smoke: FAIL — systemd-journal group cannot read the system journal:" >&2
    echo "${JOURNAL_READ:-(no output)}" >&2
    docker_exec /usr/bin/systemd-tmpfiles --cat-config >&2 2>/dev/null || true
    exit 1
fi

# The clock. chronyd is condition-gated off in a container — it would be
# adjusting the *host's* clock — so what a bounded docker harness can
# check is that the image would run it on a VM and that the binary the
# cull produced is complete. The functional check (a PTP-disciplined
# clock) belongs to the VM test.
CHRONY_ENABLED=$(docker_exec /usr/bin/systemctl is-enabled chronyd.service 2>&1 || true)
if [[ "$CHRONY_ENABLED" != "enabled" ]]; then
    echo "boot_smoke: FAIL — chronyd.service is not enabled: ${CHRONY_ENABLED:-(no output)}" >&2
    exit 1
fi
CHRONY_CONDITION=$(docker_exec /usr/bin/systemctl show chronyd.service \
    --property=ConditionResult --value 2>&1 || true)
if [[ "$CHRONY_CONDITION" != "no" ]]; then
    echo "boot_smoke: FAIL — chronyd.service ran inside a container (ConditionResult=$CHRONY_CONDITION);" >&2
    echo "  a container shares the host clock and must never discipline it" >&2
    exit 1
fi
CHRONY_VERSION=$(docker_exec /usr/bin/chronyd -v 2>&1 | head -1 || true)
if [[ "$CHRONY_VERSION" != *"chronyd (chrony) version"* ]]; then
    echo "boot_smoke: FAIL — chronyd did not report a version: ${CHRONY_VERSION:-(no output)}" >&2
    exit 1
fi
# chronyd writes its drift file after dropping to uid 106, so the baked
# state directory has to belong to that account. systemd cannot express
# this — StateDirectory= re-applies the unit's User= (root) on every
# exec, silently taking the directory back — which is exactly why this
# one is baked, and exactly the kind of thing that would rot unnoticed:
# a chronyd that cannot save drift still starts, still syncs, and just
# re-learns the clock's frequency from scratch on every boot.
if ! grep -q ' 106/107 ' <<<"$CHRONY_STATE"; then
    echo "boot_smoke: FAIL — /var/lib/chrony is not baked as chrony:chrony (106/107):" >&2
    echo "${CHRONY_STATE:-(absent from every layer)}" >&2
    exit 1
fi

# `systemctl status` is half of the owner's debugging surface, and the
# half that shows what is actually running inside a unit comes from a
# separate bus method (GetUnitProcesses) that the base's deny policy has
# to re-allow by name. When it is missing the command still succeeds and
# still prints the unit — only the process tree under CGroup: goes
# quietly empty. Assert the tree, not the exit status, and do it as uid
# 1000, because root is not who has this problem.
STATUS_TREE=$(timeout --signal=KILL 15s docker exec --user 1000:1000 "$CID" \
    /usr/bin/systemctl status --no-pager dbus.service 2>&1 || true)
if ! grep -q '/usr/bin/dbus-daemon' <<<"$STATUS_TREE"; then
    echo "boot_smoke: FAIL — 'systemctl status' as uid 1000 shows no process tree;" >&2
    echo "  the bus policy is probably denying GetUnitProcesses again" >&2
    echo "$STATUS_TREE" >&2
    exit 1
fi

if [[ "$DEV" -eq 1 ]]; then
    echo "boot_smoke: checking user manager, cgroup placement, core limits, and bubblewrap installation"
    if ! docker_exec /usr/bin/systemctl is-active --quiet user@1000.service; then
        echo "boot_smoke: FAIL — user@1000.service is not active" >&2
        exit 1
    fi
    USER_OUTPUT=""
    if ! USER_OUTPUT=$(timeout --signal=KILL 15s docker exec \
        --user 1000:1000 \
        --env HOME=/home/exedev \
        --env USER=exedev \
        --env BASH_ENV=/proc/self/cgroup \
        --env PATH=/nonexistent \
        "$CID" /usr/lib/minimos/login-shell -c \
        'set -euo pipefail; scope_unit=; printf "cgroup="; while IFS= read -r line; do printf "%s\n" "$line"; scope_unit=${line##*/}; done </proc/self/cgroup; test -n "$scope_unit"; printf "scope-io-accounting="; /usr/bin/systemctl --user show "$scope_unit" --property=IOAccounting --value; printf "default-io-accounting="; /usr/bin/systemctl --user show --property=DefaultIOAccounting --value; printf "core-soft="; ulimit -Sc; printf "core-hard="; ulimit -Hc; printf "user-state="; /usr/bin/systemctl --user is-system-running; printf "bwrap="; /usr/bin/bwrap --version' 2>&1); then
        echo "boot_smoke: FAIL — bounded login probe failed:" >&2
        echo "$USER_OUTPUT" >&2
        docker_exec /usr/bin/systemctl status --no-pager user@1000.service >&2 || true
        docker_exec /usr/bin/journalctl --no-pager -u user@1000.service -n 30 >&2 || true
        exit 1
    fi
    probe_says() {
        grep -q "$1" <<<"$USER_OUTPUT" && return 0
        echo "boot_smoke: FAIL — login probe did not report $2:" >&2
        echo "$USER_OUTPUT" >&2
        exit 1
    }
    probe_says 'cgroup=0::/user.slice/user-1000.slice/user@1000.service/' \
        'a login shell inside the delegated user cgroup'
    probe_says 'scope-io-accounting=yes' 'IO accounting on the login scope'
    probe_says 'default-io-accounting=yes' 'IO accounting as the user default'
    probe_says 'core-soft=0' 'a zero soft core limit'
    probe_says 'core-hard=0' 'a zero hard core limit'
    probe_says 'user-state=running' 'a running user manager'
    # Docker's built-in nested-container policy rejects bwrap's pivot_root.
    # Keep that outer seccomp barrier intact here; the real-VM integration
    # test performs the functional namespace/mount probe.
    probe_says 'bwrap=bubblewrap ' 'an installed bubblewrap'
fi

if [[ "$CONTAINERS" -eq 1 ]]; then
    echo "boot_smoke: checking the gVisor runtime and containerd's configuration"
    for runtime_binary in runsc containerd-shim-runsc-v1; do
        if ! grep -q "/${runtime_binary}\$" <<<"$GVISOR_FOUND"; then
            echo "boot_smoke: FAIL — no image layer ships $runtime_binary" >&2
            exit 1
        fi
    done

    # The binaries execute here, which is all a container-less harness can
    # ask of them: docker's own seccomp and nested-container policy stop a
    # sandbox from actually starting, so booting a container under gVisor
    # is a real-VM integration check (see the example README).
    RUNSC_VERSION=$(docker_exec /usr/local/bin/runsc --version 2>&1 | head -1 || true)
    if [[ "$RUNSC_VERSION" != "runsc version"* ]]; then
        echo "boot_smoke: FAIL — runsc did not report a version: ${RUNSC_VERSION:-(no output)}" >&2
        exit 1
    fi
    echo "boot_smoke: $RUNSC_VERSION"

    # containerd's merged view of its configuration: this is the check
    # that our TOML both parsed and outranked the compiled-in defaults,
    # which a file with a mistyped plugin path would silently fail.
    CONFIG_DUMP=$(docker_exec /usr/bin/containerd config dump 2>&1 || true)
    for setting in \
        "default_runtime_name = 'runsc'" \
        "runtime_type = 'io.containerd.runsc.v1'" \
        "ConfigPath = '/etc/containerd/runsc/config.toml'"; do
        if ! grep -qF "$setting" <<<"$CONFIG_DUMP"; then
            echo "boot_smoke: FAIL — containerd's effective config lacks: $setting" >&2
            echo "$CONFIG_DUMP" | head -40 >&2
            exit 1
        fi
    done

    # A client round-trip proves the daemon is actually serving, which
    # `systemctl is-active` alone does not: containerd notifies readiness
    # before its plugins have all settled.
    CTR_VERSION=$(docker_exec /usr/bin/ctr version 2>&1 || true)
    if ! grep -q '^  Version:' <<<"$CTR_VERSION"; then
        echo "boot_smoke: FAIL — ctr could not reach containerd:" >&2
        echo "${CTR_VERSION:-(no output)}" >&2
        exit 1
    fi
    NERDCTL_NAMESPACES=$(docker_exec /usr/bin/nerdctl namespace ls 2>&1 || true)
    if ! grep -q 'NAME' <<<"$NERDCTL_NAMESPACES"; then
        echo "boot_smoke: FAIL — nerdctl could not reach containerd:" >&2
        echo "${NERDCTL_NAMESPACES:-(no output)}" >&2
        exit 1
    fi

    # The socket handover to uid 1000, end to end: the account exe.dev
    # logs SSH sessions into has to be able to drive the daemon, or the
    # image can only ever run what was baked into it. containerd's own
    # [grpc] uid/gid keys no longer do this in 2.x — they parse and are
    # ignored — so the unit does it with systemd-tmpfiles after startup,
    # and this check is what would notice that regressing.
    OWNER_CTR=$(timeout --signal=KILL 15s docker exec --user 1000:1000 "$CID" \
        /usr/bin/ctr version 2>&1 || true)
    if ! grep -q '^  Version:' <<<"$OWNER_CTR"; then
        echo "boot_smoke: FAIL — uid 1000 cannot reach the containerd socket:" >&2
        echo "${OWNER_CTR:-(no output)}" >&2
        docker_exec /usr/bin/systemctl status --no-pager containerd.service >&2 || true
        exit 1
    fi

    # The workload template has to carry the CRI sandbox annotation.
    # Without it gVisor's shim never wires the container's stdio and
    # blocks in Create until the task times out — a failure that only
    # appears when a container is actually started, which no bounded
    # docker harness can do. Assert the flag is still there instead.
    ANNOTATION=$(docker_exec /usr/bin/bash -c \
        'unit=$(</etc/systemd/system/container@.service); case $unit in *"--annotation io.kubernetes.cri.container-type=sandbox"*) echo present ;; *) echo missing ;; esac' 2>&1 || true)
    if [[ "$ANNOTATION" != "present" ]]; then
        echo "boot_smoke: FAIL — container@.service lost the CRI sandbox annotation gVisor's shim needs" >&2
        exit 1
    fi

    # The workload template refuses a tag-only image reference and bounds
    # its own logs. Both are one line each in a unit nobody re-reads, and
    # both fail open if dropped — an unpinned image still runs, and an
    # unbounded log only shows up as a full disk weeks later.
    for guard in '*@sha256:*' '--log-opt max-size'; do
        FOUND=$(docker_exec /usr/bin/bash -c \
            "unit=\$(</etc/systemd/system/container@.service); case \$unit in *'$guard'*) echo present ;; *) echo missing ;; esac" 2>&1 || true)
        if [[ "$FOUND" != "present" ]]; then
            echo "boot_smoke: FAIL — container@.service no longer carries: $guard" >&2
            exit 1
        fi
    done

    # Container networking shells out to `iptables`, and which backend
    # answers is a boot-time property of the image's symlinks. The
    # platform kernel has nf_tables built in and no module can be loaded
    # after minimos-harden.service, so the legacy backend would be a
    # runtime surprise rather than a build-time one.
    IPTABLES_VERSION=$(docker_exec /usr/bin/iptables --version 2>&1 || true)
    if [[ "$IPTABLES_VERSION" != *"(nf_tables)"* ]]; then
        echo "boot_smoke: FAIL — /usr/bin/iptables is not the nft backend: ${IPTABLES_VERSION:-(no output)}" >&2
        exit 1
    fi
fi

USERSPACE_MSG="no distro userspace"
[[ "$USERLAND" -eq 1 ]] && USERSPACE_MSG="userland image, no package manager"
[[ "$CONTAINERS" -eq 1 ]] && USERSPACE_MSG="$USERSPACE_MSG, gVisor is the only OCI runtime"
echo "boot_smoke: PASS — systemd running, 0 failed units, required services active, $USERSPACE_MSG, no suid/world-writable, accounts stable"
