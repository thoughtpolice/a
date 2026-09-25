#!/bin/bash
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
#
# Boot a minimos OCI image under docker and check it. Before anything
# runs, the layers are scanned for package managers, setuid or setgid
# files, and world-writable paths outside sticky directories. Then
# systemd boots in a bounded container, and the test requires:
#
#   - `systemctl is-system-running` to reach "running", with no failed units
#   - dbus, journald, logind and every EXTRA_UNIT to be active
#   - a boot journal with no warnings beyond four known lines
#   - plain `[  OK  ]` status lines on the console
#   - /etc/{passwd,group,shadow} to match the baked copies
#   - the systemd-journal group to be able to read the journal
#   - uid 1000 to see the process tree in `systemctl status`
#   - the VM-only units to be wired up and skipped under docker
#
# Needs docker and GNU timeout on the host. This is a smoke test for a
# dev machine, not a hermetic unit test, and a sandbox for trusted build
# output rather than hostile images.
#
# Usage: boot_smoke.sh SKOPEO SCRATCH_IMAGE OCI_LAYOUT --image-cmd CSV
#        [--base-layer-count N] [--policy FILE]
#        [--userland] [--dev] [--containers] [EXTRA_UNIT...]
#
#   --userland    The image ships an interactive userland on purpose, so
#                 coreutils and other shells are allowed. Package managers
#                 and the file mode and account checks still apply.
#   --dev         Check the lingering user manager and the login wrapper's
#                 bounded scope.
#   --containers  Check that gVisor is the only OCI runtime in any layer
#                 and that containerd runs with it as the default.

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

# fail MESSAGE [DETAIL]: report a failure, plus any multi-line detail, and exit.
fail() {
    echo "boot_smoke: FAIL: $1" >&2
    if [[ -n "${2:-}" ]]; then
        printf '%s\n' "$2" >&2
    fi
    exit 1
}

if ! command -v docker >/dev/null 2>&1; then
    fail "docker is not available"
fi
if ! command -v timeout >/dev/null 2>&1; then
    fail "timeout is not available, and this test won't run unbounded"
fi

# ---------------------------------------------------------------------------
# Static checks, before docker loads or runs anything.
# ---------------------------------------------------------------------------

# Descriptors, digests, layer metadata and the composition policy, through
# the same validator scratch_image ran at build time.
VALIDATOR_ARGS=(
    validate "$OCI_LAYOUT"
    --expected-cmd "$IMAGE_CMD_CSV"
    --base-layer-count "$BASE_LAYER_COUNT"
)
if [[ -n "$POLICY" ]]; then
    VALIDATOR_ARGS+=(--policy "$POLICY")
fi
timeout --signal=KILL 30s "$VALIDATOR" "${VALIDATOR_ARGS[@]}"

# Every directory a program on the image's PATH can live in.
BIN='^(\./)?(usr/)?(local/)?(bin|sbin)/'
BANNED_USERLAND="${BIN}(zsh|ash|fish|ksh|csh|tcsh|busybox|ls|cat|cp|rm)\$"
BANNED_ALWAYS="${BIN}(apt|apt-get|dpkg|snap|apk|dnf|microdnf|yum|rpm|pacman|zypper|nix|nix-env|guix)\$"
# A container host is sandboxed because gVisor is the only thing in the
# image that can start a container. A runc, crun or runc shim arriving in
# some package's dependencies would quietly end that.
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
        fail "timed out listing image blob $blob"
    fi
    # The manifest and config are JSON rather than tar. The validator above
    # has checked them, so only layers take part in this scan.
    [[ "$tar_status" -eq 0 ]] || continue
    if [[ "$USERLAND" -eq 0 ]] && grep -qE "$BANNED_USERLAND" <<<"$listing"; then
        fail "distro userspace in an image layer:" "$(grep -E "$BANNED_USERLAND" <<<"$listing")"
    fi
    if grep -qE "$BANNED_ALWAYS" <<<"$listing"; then
        fail "package manager in an image layer:" "$(grep -E "$BANNED_ALWAYS" <<<"$listing")"
    fi
    if [[ "$CONTAINERS" -eq 1 ]]; then
        if grep -qE "$BANNED_RUNTIMES" <<<"$listing"; then
            fail "an OCI runtime other than gVisor is in an image layer:" \
                "$(grep -E "$BANNED_RUNTIMES" <<<"$listing")"
        fi
        GVISOR_FOUND+=$'\n'$(grep -E "$GVISOR_RUNTIME" <<<"$listing" || true)
    fi
    set +e
    verbose=$(timeout --signal=KILL 10s tar -tvf "$blob" 2>/dev/null)
    tar_status=$?
    set -e
    if [[ "$tar_status" -ne 0 ]]; then
        fail "layer became unreadable while checking modes: $blob"
    fi
    suid=$(awk '$1 !~ /^l/ && (substr($1,4,1) ~ /[sS]/ || substr($1,7,1) ~ /[sS]/)' <<<"$verbose")
    if [[ -n "$suid" ]]; then
        fail "setuid or setgid entries in an image layer:" "$suid"
    fi
    CHRONY_STATE+=$'\n'$(awk '$NF ~ /^(\.\/)?var\/lib\/chrony\/?$/' <<<"$verbose" || true)
    ww=$(awk '$1 !~ /^l/ && substr($1,9,1) == "w" && !($1 ~ /^d/ && substr($1,10,1) ~ /[tT]/)' <<<"$verbose")
    if [[ -n "$ww" ]]; then
        fail "world-writable entries in an image layer:" "$ww"
    fi
done

# chronyd writes its drift file after dropping to uid 106, so the baked
# state directory has to belong to chrony. StateDirectory= can't do this,
# because systemd resets an Exec directory to the unit's User= on every
# exec. A chronyd that can't save drift still starts and still syncs, and
# relearns the clock's frequency on every boot, so nothing else would
# notice.
if ! grep -q ' 106/107 ' <<<"$CHRONY_STATE"; then
    fail "/var/lib/chrony is not baked as chrony:chrony (106/107):" \
        "${CHRONY_STATE:-(absent from every layer)}"
fi

# ---------------------------------------------------------------------------
# Boot.
# ---------------------------------------------------------------------------

echo "boot_smoke: loading $OCI_LAYOUT into docker as $TAG"
timeout --signal=KILL 90s "$SKOPEO" --insecure-policy copy \
    "oci:$OCI_LAYOUT:latest" "docker-daemon:$TAG"

echo "boot_smoke: running systemd with a private cgroup namespace and bounded capabilities"
# The image's own Cmd boots on a pty, so the --show-status lines land in
# `docker logs` the way they land on the exe.dev console. systemd's log
# messages go to the journal, and a failure dumps them from there.
#
# AppArmor is the one outer layer PID 1 can't run under. docker-default
# denies mount propagation changes, and systemd starts its generators in
# a private mount namespace that first makes / MS_SLAVE. That fails in the
# child, the manager only sees an exit status, and PID 1 exits. Seccomp,
# the capability bound and no-new-privileges stay on, and on a host
# without AppArmor the option changes nothing.
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
    fail "docker could not start the container:" "$RUN_OUTPUT"
fi
CID=$(<"$CID_FILE")
if [[ ! "$CID" =~ ^[0-9a-f]{12,64}$ ]]; then
    fail "docker returned an invalid container ID: $CID"
fi
echo "boot_smoke: container $CID"

docker_exec() {
    timeout --signal=KILL 10s docker exec "$CID" "$@"
}

# The image has no coreutils, so files inside it are read with bash.
read_in_image() {
    docker_exec /usr/bin/bash -c 'printf "%s" "$(<"$1")"' _ "$1"
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
    echo "=== failed units ==="
    docker_exec /usr/bin/systemctl --no-pager list-units --state=failed || true
    echo "=== recent journal ==="
    docker_exec /usr/bin/journalctl --no-pager -n 50 || true
    echo "=== console ==="
    timeout --signal=KILL 10s docker logs --tail 200 "$CID" || true
    fail "system not running (state=$STATE)"
fi

FAILED=$(docker_exec /usr/bin/systemctl --no-pager --no-legend list-units --state=failed 2>&1)
if [[ -n "$FAILED" ]]; then
    fail "units in failed state:" "$FAILED"
fi

for unit in dbus.service systemd-journald.service systemd-logind.service "${EXTRA_UNITS[@]}"; do
    if ! docker_exec /usr/bin/systemctl is-active --quiet "$unit"; then
        docker_exec /usr/bin/systemctl status --no-pager "$unit" >&2 || true
        fail "required unit $unit is not active"
    fi
done

# ---------------------------------------------------------------------------
# Runtime checks.
# ---------------------------------------------------------------------------

# user-workload.slice matches systemd's generic user-.slice.d drop-ins by
# name. Check the value systemd settled on, so a vendor default can't
# quietly replace the ceiling.
WORKLOAD_TASKS_MAX=$(docker_exec /usr/bin/systemctl show \
    user-workload.slice --property=TasksMax --value 2>&1)
if [[ "$WORKLOAD_TASKS_MAX" != "2048" ]]; then
    docker_exec /usr/bin/systemctl cat user-workload.slice >&2 || true
    fail "user-workload.slice TasksMax=$WORKLOAD_TASKS_MAX, expected 2048"
fi

# user.slice's I/O ceiling is io.max on the root filesystem's device.
# Docker's overlay root has no block device behind it, so the file is
# usually empty here and the real check happens on a VM.
USER_IO_MAX=$(read_in_image /sys/fs/cgroup/user.slice/io.max 2>/dev/null || true)
if [[ -n "$USER_IO_MAX" ]]; then
    for io_limit in rbps=500000000 wbps=250000000 riops=50000 wiops=25000; do
        if ! grep -Eq "(^|[[:space:]])${io_limit}([[:space:]]|$)" <<<"$USER_IO_MAX"; then
            fail "user.slice io.max lacks $io_limit: $USER_IO_MAX"
        fi
    done
else
    echo "boot_smoke: no block device behind the docker root; io.max is checked on a VM"
fi

# The boot journal must be free of warnings. Two kinds of real defect only
# show up here, a hardening directive the manager ignored while the unit
# still reports active, and a vendor config naming an account, device or
# path the image lacks.
#
# Each tolerated line is matched whole, with the reason it's harmless:
#
#   block device: docker's overlay root has no block device, so PID 1
#     can't resolve user.slice's io.max. A VM's virtio root can.
#   io pressure: this also happens on VMs. The user manager re-arms a PSI
#     trigger, the kernel allows one per file descriptor and returns
#     EBUSY, and systemd ignores it. The io controller is delegated all
#     the way to user@1000.service either way.
#   libbpf and kmod: minimos ships neither library on purpose. libbpf only
#     gates SocketBind*=, RestrictNetworkInterfaces= and
#     RestrictFileSystems=, which minimos doesn't use.
#     IPAddressDeny=/IPAddressAllow= use raw bpf() calls and work without
#     it. Module loading is shut off, so there's nothing for libkmod to
#     do, and that line only appears on VMs.
BOOT_WARNINGS=$(docker_exec /usr/bin/journalctl -b -p warning --no-pager -o cat 2>&1 | \
    grep -vEe '^$' \
         -e "^'/' is not a block device node, and file system block device cannot be determined or is not local\.$" \
         -e '^Failed to adjust io pressure threshold, ignoring: Device or resource busy$' \
         -e '^Neither libbpf\.so\.[0-9]+ nor libbpf\.so\.[0-9]+ are installed, cgroup BPF features disabled\.$' \
         -e '^Failed to initialize kmod context: Operation not supported$' \
    || true)
if [[ -n "$BOOT_WARNINGS" ]]; then
    fail "the boot journal has warnings:" "$BOOT_WARNINGS"
fi

# `ssh exe.dev vm-logs` shows this console, so it needs the status lines
# and no ANSI escapes.
CONSOLE=$(timeout --signal=KILL 10s docker logs --tail 400 "$CID" 2>&1)
if ! grep -q '\[  OK  \]' <<<"$CONSOLE"; then
    fail "no '[  OK  ]' status lines on the console"
fi
if grep -q $'\x1b' <<<"$CONSOLE"; then
    fail "ANSI escapes on the console:" "$(grep -m 3 $'\x1b' <<<"$CONSOLE" | cat -v)"
fi

# Exactly one layer, the base overlay, ships each account file, and
# nothing rewrites them at boot. A difference here means something new
# has started editing accounts.
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
        fail "etc/$f is in $found layers, expected only the base overlay"
    fi
    booted=$(read_in_image "/etc/$f")
    if [[ "$booted" != "${baked%$'\n'}" ]]; then
        fail "/etc/$f changed at boot:" \
            "$(diff <(printf '%s\n' "${baked%$'\n'}") <(printf '%s\n' "$booted") || true)"
    fi
done

# The owner reads logs through the systemd-journal group, which only
# works because tmpfiles fixes the group on journald's directory. Test
# the group directly, because `docker exec --user` doesn't pick up
# supplementary groups from the image's /etc/group the way the platform
# sshd does.
JOURNAL_READ=$(timeout --signal=KILL 15s docker exec --user 1000:105 "$CID" \
    /usr/bin/journalctl -b -n 1 --no-pager -o cat 2>&1 || true)
if [[ -z "$JOURNAL_READ" || "$JOURNAL_READ" == *"insufficient permissions"* || "$JOURNAL_READ" == *"No journal files"* ]]; then
    docker_exec /usr/bin/systemd-tmpfiles --cat-config >&2 2>/dev/null || true
    fail "the systemd-journal group can't read the journal:" "${JOURNAL_READ:-(no output)}"
fi

# The process tree in `systemctl status` comes from GetUnitProcesses,
# which the base's bus policy has to allow by name. Without it the
# command still succeeds and just shows no processes, so check the tree
# itself, as uid 1000.
STATUS_TREE=$(timeout --signal=KILL 15s docker exec --user 1000:1000 "$CID" \
    /usr/bin/systemctl status --no-pager dbus.service 2>&1 || true)
if ! grep -q '/usr/bin/dbus-daemon' <<<"$STATUS_TREE"; then
    fail "'systemctl status' as uid 1000 shows no process tree, is GetUnitProcesses denied?" \
        "$STATUS_TREE"
fi

# Units that only make sense on a VM. Each must be pulled in at boot and
# then skipped here by ConditionVirtualization=!container. chronyd would
# be setting the host's clock, and systemd-growfs would fail on an
# overlay root.
skipped_in_container() {
    local unit="$1" evaluated result
    evaluated=$(docker_exec /usr/bin/systemctl show "$unit" \
        --property=ConditionTimestampMonotonic --value 2>&1 || true)
    result=$(docker_exec /usr/bin/systemctl show "$unit" \
        --property=ConditionResult --value 2>&1 || true)
    if [[ ! "$evaluated" =~ ^[1-9][0-9]*$ ]]; then
        fail "$unit was never started at boot"
    fi
    if [[ "$result" != "no" ]]; then
        fail "$unit ran inside a container (ConditionResult=$result)"
    fi
}
CHRONY_ENABLED=$(docker_exec /usr/bin/systemctl is-enabled chronyd.service 2>&1 || true)
if [[ "$CHRONY_ENABLED" != "enabled" ]]; then
    fail "chronyd.service is not enabled: ${CHRONY_ENABLED:-(no output)}"
fi
skipped_in_container chronyd.service
CHRONY_VERSION=$(docker_exec /usr/bin/chronyd -v 2>&1 | head -1 || true)
if [[ "$CHRONY_VERSION" != *"chronyd (chrony) version"* ]]; then
    fail "chronyd did not report a version: ${CHRONY_VERSION:-(no output)}"
fi
GROWFS_WANTED_BY=$(docker_exec /usr/bin/systemctl show systemd-growfs-root.service \
    --property=WantedBy --value 2>&1 || true)
if [[ " $GROWFS_WANTED_BY " != *" local-fs.target "* ]]; then
    fail "local-fs.target doesn't want systemd-growfs-root.service (WantedBy=$GROWFS_WANTED_BY)"
fi
skipped_in_container systemd-growfs-root.service

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
