# minimos examples

Worked compositions on the minimos base layer, in rough order of
complexity. Copy the closest one as a starting point; each is a complete
package (BUILD + PACKAGE + keep/deny lists + unit + config).

| example      | shows                                                     | image target         |
| ------------ | --------------------------------------------------------- | -------------------- |
| `memcached/` | the minimum: one culled binary, one flags-only unit       | `:minimos-memcached` |
| `valkey/`    | a config file, a state dir, a CLI kept for verification   | `:minimos-valkey`    |
| `nginx/`     | static content, multiple HTTP ports, exe.dev proxy usage  | `:minimos-nginx`     |
| `dev/`       | an interactive userland + a lingering per-user manager    | `:minimos-dev`       |
| `codex/`     | a GitHub-release binary overlaid on the dev machine       | `:minimos-codex`     |

Every `minimos.image()` emits `<name>`, `<name>-docker` (for
`docker load`), and `<name>-boot-smoke` (docker-based boot test), so:

```
buck2 test //src/images/minimos/examples/...
```

boots them all under docker and asserts systemd reaches `running` with
each example's service active. The harness statically rejects unsafe image
metadata before execution, then uses a private cgroup namespace, no network,
bounded memory/CPU/PIDs/logs/tmpfs, timeouts, `no-new-privileges`, and an
explicit capability set. It does not use Docker `--privileged`. Systemd still
needs `SYS_ADMIN` inside the test container, so treat this as an integration
test for trusted build artifacts; run adversarial images only on a disposable
Docker host or VM.

## dev/ and codex/ — machines, not appliances

The first three examples are appliances: one service, no shell tools.
`dev/` flips the image into a day-to-day machine: coreutils, findutils,
grep/sed/gawk, tar/gzip/xz, git, jq, ripgrep, procps, less, curl, and
bubblewrap from pinned Wolfi packages, plus a running
`systemd --user` for uid 1000 — exedev is marked lingering, a drop-in
resets the `PAMName=` our PAM-less rootfs can't satisfy (and sets
`XDG_RUNTIME_DIR`, pam_systemd's other job), and a small culled layer
restores the `systemd-user-runtime-dir` binary and `loginctl` that the
base denylist drops.

The local root account is locked and has `nologin`; exe.dev maps external SSH
names, including `root`, to the configured `exedev` uid 1000 account. On these
dev images, `/etc/minimos/require-user-scope` makes the exedev shell wrapper
fail closed unless it can start the requested Bash shell or command with
`systemd-run --user --scope`. This moves it out of the platform listener's
`init.scope` and underneath `user@1000.service`. The user manager and each SSH
scope delegate `cpu cpuset io memory pids`; each scope has CPU/I/O weight 100,
`MemoryHigh=65%`, `MemoryMax=75%`, no swap, and `TasksMax=2048`. The parent
`user.slice` has a 70%/80% memory high/max policy, no swap, and a 3072-task
aggregate ceiling. It also caps aggregate root-filesystem I/O at 500/250 MB/s
read/write and 50K/25K read/write IOPS. CPU and supported I/O weights remain
work-conserving contention priorities, not per-tenant entitlements; on
exe.dev's current weightless block scheduler, the hard bandwidth/IOPS values
are the effective I/O policy. The user manager enables I/O/memory/task
accounting and applies a zero hard core-file limit to user-created services.

Shell and remote-command channels take that wrapper path. The current exe.dev
SFTP subsystem does not: live validation found its authenticated uid-1000
handler still in `init.scope`, outside `user.slice`'s memory and I/O ceilings.
The 512-task init-scope limit remains, but SFTP/forwarding must be moved by the
platform into a bounded user scope before these images can claim complete
per-session QoS. Capping all of `init.scope` is unsafe because it also contains
PID 1 and the platform listener.

The dev boot smoke passes `--userland`, which waives the appliance's
no-coreutils check but keeps the package-manager, file-mode, and baked-account
invariants. Its `--dev` checks also exercise the user manager, wrapper cgroup
placement, zero core limits, and bubblewrap installation. Docker's nested
container policy rejects bubblewrap's `pivot_root`, so a real exe.dev deployment
must additionally exercise a functional bubblewrap namespace/mount probe along
with platform SSH, VM-only sysctls, and the realized `user.slice/io.max`
values; Docker overlay storage may not expose a resolvable originating block
device to the private test cgroup.

`codex/` stacks OpenAI's Codex CLI on top as a plain overlay: the
static musl binary from the pinned GitHub release lands at
`/usr/local/bin/codex`, and `~/.codex/config.toml` preconfigures the
`exe-chatgpt` model provider. Attach an exe.dev integration named `chatgpt`
when creating the VM; that integration makes
`https://chatgpt.int.exe.xyz/v1` available to the VM and proxies it to the
owning account without putting an API key in the image. A tag alone does not
attach an integration. Codex's Linux command sandbox uses the image's
unprivileged bubblewrap and the user namespaces minimos keeps enabled.

```
ssh exe.dev new --image=<pushed image> --name=agent --integration=chatgpt
ssh agent.exe.xyz
codex            # interactive; provider comes from ~/.codex/config.toml
codex exec 'summarize this repo'   # non-interactive
```

The same provider can be configured ad hoc on a stock codex install:

```
codex \
  -c model_provider=exe-chatgpt \
  -c 'model_providers.exe-chatgpt.name="exe-chatgpt"' \
  -c 'model_providers.exe-chatgpt.base_url="https://chatgpt.int.exe.xyz/v1"'
```

## Sandbox and shared-resource boundary

`dev/` and `codex/` provide same-owner process sandboxing, not a general
rootless OCI host. They do not ship Docker, Podman, containerd, runc/crun,
subordinate-ID helpers or allocations, rootless networking, or a writable-layer
storage driver. Cgroup delegation and usable user namespaces are prerequisite
plumbing for a future runtime composition, not evidence that arbitrary
devenv/container images work today.

Bubblewrap changes what a process can see inside its namespaces, but outside
them the process is still owned by host uid 1000. It is not a security boundary
between mutually untrusted users, and it cannot hide a host resource that its
caller deliberately mounts or connects. For same-owner development sandboxes:

- share named workspace directories, not all of `/home/exedev`, and make caches
  and source inputs read-only whenever possible;
- do not expose `/run/user/1000/bus`, a runtime-control socket, SSH agent,
  `/exe.dev`, host devices, host cgroups, `.ssh`, `.codex`, or unrelated repos;
- give each workload its own cgroup ceilings and a filesystem quota or dedicated
  volume, because cgroups do not prevent disk exhaustion;
- treat network reachability to an attached exe.dev integration as an
  authorization capability, even though no upstream API key is stored locally.

Mutually untrusted workloads require separate host users with disjoint storage,
cgroups, user managers, and subordinate-ID ranges, or separate VMs. The shipped
examples implement only the single `exedev` owner; separate exe.dev VMs are the
available strong boundary without building a different multi-user runtime.

## Trying one out

Local (memcached shown; substitute any example):

```
buck2 test //src/images/minimos/examples/memcached:minimos-memcached-boot-smoke

# Optional static inspection; use the target above, not a privileged Docker
# invocation, to boot the image locally.
docker load < $(buck2 build //src/images/minimos/examples/memcached:minimos-memcached-docker --show-full-simple-output)
```

On exe.dev (push to ttl.sh, boot a VM, then poke it over SSH):

```
docker load < $(buck2 build //src/images/minimos/examples/memcached:minimos-memcached-docker --show-full-simple-output)
docker tag minimos-memcached:latest ttl.sh/$USER-minimos-memcached:1h
docker push ttl.sh/$USER-minimos-memcached:1h
ssh exe.dev new --image=ttl.sh/$USER-minimos-memcached:1h --name mos-memcached
ssh mos-memcached.exe.xyz  # bash + systemctl/journalctl; no coreutils
```

ttl.sh tags are mutable but cached by digest on the platform side:
when you push a changed image, use a fresh tag or the VM may boot the
stale bytes.

In-VM verification, coreutils-free (the appliance images):

- memcached: `exec 3<>/dev/tcp/127.0.0.1/11211; printf 'version\r\n' >&3; read -r v <&3; echo "$v"`
- valkey: `valkey-cli ping` → `PONG`
- nginx: visit `https://<vm>.exe.xyz/` (or `curl` from anywhere)

The dev/codex images have real coreutils, so verify like a normal
machine: `systemctl --user is-system-running`, `loginctl list-users`,
`git --version`, `codex --version`.
