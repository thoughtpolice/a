# minimos examples

Worked compositions on the minimos base layer, in rough order of
complexity. Copy the closest one as a starting point; each is a complete
package (BUILD + PACKAGE + keep/deny lists + unit + config).

| example           | shows                                                     | image target              |
| ----------------- | --------------------------------------------------------- | ------------------------- |
| `memcached/`      | the minimum: one culled binary, one flags-only unit       | `:minimos-memcached`      |
| `valkey/`         | a config file, a state dir, a CLI kept for verification   | `:minimos-valkey`         |
| `nginx/`          | static content, multiple HTTP ports, exe.dev proxy usage  | `:minimos-nginx`          |
| `dev/`            | an interactive userland + a lingering per-user manager    | `:minimos-dev`            |
| `codex/`          | a GitHub-release binary overlaid on the dev machine       | `:minimos-codex`          |
| `container-host/` | containerd with gVisor as the only OCI runtime            | `:minimos-container-host` |

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
`systemd --user` for uid 1000. exedev is marked lingering, and a small
culled layer restores the `systemd-user-runtime-dir` binary and `loginctl`
that the base denylist drops. The base already carries the `user@.service`
drop-ins that reset the `PAMName=` our PAM-less rootfs can't satisfy and set
`XDG_RUNTIME_DIR`, pam_systemd's other job. They sit unused until something
lingers, and the composition policy wouldn't let this layer add them anyway.

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

## container-host/ — an appliance that runs other people's containers

The Bottlerocket-shaped composition: containerd, the CNI plugins and
iptables its networking shells out to, and **gVisor as the only OCI
runtime on the machine**. It ships no userland — the userland arrives
inside the sandboxes — so it keeps the appliance layer checks the dev
images waive.

"Only runtime" is image content, not configuration. There is no runc, no
crun, and no `containerd-shim-runc-v2` in any layer, so the conventional
default runtime cannot start a container here at all; the boot smoke
re-derives that from the built layers. containerd's CRI plugin, the one
place containerd has a server-side default, names `runsc` as it. Sandbox
behavior comes from `/etc/containerd/runsc/config.toml`, which the shim
finds on its own — containerd only forwards runtime options a *client*
asked for, and `nerdctl`/`ctr` send none, so that fallback path is the
only way to configure every sandbox on the system at once.

### Running a workload

A container is declared as data and started by systemd:

```
# /etc/minimos/containers/web.env, shipped by a layer stacked on this image
IMAGE=docker.io/library/nginx:1.29-alpine
RUN_ARGS=--publish 80:80 --memory 256m --cpus 1
COMMAND=
```

plus a `multi-user.target.wants/container@web.service` symlink to the
`container@.service` template the image installs. That indirection is not
ceremony — see below for why it is the only way in.

Two things the template enforces so a workload cannot quietly opt out:

- **`IMAGE` must be digest-pinned** (`…@sha256:…`), checked by an
  `ExecStartPre` that fails the unit otherwise. Every other input to
  these images is pinned by hash; a workload image is the one that
  arrives at runtime from a registry, and a tag can be re-pointed between
  the boot that was tested and the boot that runs. TLS proves who served
  the bytes, not which bytes were promised.
- **Container logs are bounded** (`--log-opt max-size=16m max-file=3`,
  overridable from `RUN_ARGS`). Cgroups cap memory, CPU and pids but
  never bytes written, so an unbounded json-file log is the likeliest way
  this host fills its root filesystem. The content store is the other
  way, and it is not bounded: containerd's GC reclaims unreferenced
  content, not images you pulled and stopped using, so `nerdctl rmi` and
  a disk-usage alarm remain the operator's job.

### What the SSH owner can and cannot do

`containerd.service` hands its control socket to `exedev` (uid 1000)
after startup, so `ctr` works over SSH for pulls, listing, inspection and
task control. It **cannot start a container**, and that is not a
permission that was withheld:

- `nerdctl` decides it is rootless from `geteuid()` alone. As uid 1000 it
  never looks at the socket; it looks for a rootless containerd that does
  not exist and exits.
- `ctr run` builds the OCI spec client-side, which means reading
  `/var/lib/containerd/…/snapshots/<n>/fs` directly. That path is root's,
  and on cgroup-v2 the client would need `mount(2)` anyway.

So creating a container is a build-time act on this image, the same way
creating a service is. This is a consequence of minimos having no path to
uid 0 at runtime, not of container tooling being unusual: every container
CLI assumes it either is root or has a rootless daemon of its own, and
rootless containers need setuid `newuidmap`/`newgidmap` helpers that this
image structurally refuses to ship.

Handing over the socket is itself a deliberate widening, and a total one:
anything that can reach it can start a container that bind-mounts the
host filesystem. It is the same bargain as membership in Docker's
`docker` group, taken because a container host whose owner cannot even
see what is running is not administrable. What gVisor buys is the layer
underneath — the workload runs on a userspace kernel rather than directly
on the host's syscall surface.

### The annotation every non-CRI client has to pass

gVisor's shim wires a container's stdio to runsc **only** when the OCI
spec carries `io.kubernetes.cri.container-type=sandbox`: `newInit` sets
`p.Sandbox` from that annotation alone, and `Create` passes `opts.IO`
only when `p.Sandbox` is set. Without it the shim captures runsc's output
through a pipe that the sandbox process inherits and never closes, so
`Create` blocks forever — the sandbox boots, logs `Watchdog.Start() not
called within 30s`, and the task sits in `CREATED`. Nothing reports an
error; it simply hangs.

The CRI always sets that annotation, which is why the bug is invisible in
Kubernetes. `container@.service` passes it explicitly, and the boot smoke
asserts it is still there. Ad-hoc runs need both flags:

```
nerdctl run --runtime=io.containerd.runsc.v1 \
    --annotation io.kubernetes.cri.container-type=sandbox \
    --rm docker.io/library/alpine:3 uname -a        # -> 4.19.0-gvisor
```

### Verified on a real VM

Docker cannot start a gVisor sandbox inside the bounded boot smoke —
nested seccomp and container policy stop it — so the smoke checks
composition (no other runtime present, runsc executes, containerd's
effective config, the socket handover, the annotation) and the runtime
itself is a VM check. On an exe.dev VM, with a workload unit enabled:

- the container reports `Linux 4.19.0-gvisor`, i.e. the sentry, not the
  host kernel;
- CNI bridge networking works end to end — `nerdctl0` plus a veth pair,
  and outbound HTTP from inside the sandbox succeeds. This is only true
  because the platform kernel has nf_tables built in: minimos latches
  `kernel.modules_disabled=1` during `sysinit.target`, so a backend that
  needed to load a module would fail permanently. The image's `iptables`
  symlinks therefore point at the nft multi binary, not Wolfi's legacy
  default;
- gVisor's KVM platform is unavailable (the hypervisor exposes
  `/dev/kvm` but not working nested VMX), so sandboxes use systrap, which
  needs no device.

Container cgroups land at `/sys/fs/cgroup/<namespace>/<id>`, outside the
base's slice hierarchy: nerdctl refuses the systemd cgroup manager for
any runtime other than runc and falls back to cgroupfs, so the runtime
config agrees with it rather than fighting it. Bound each workload in its
own `RUN_ARGS` (`--memory`, `--cpus`, `--pids-limit`).

Two lines in containerd's own log survive on a clean boot, and neither is
a systemd-priority warning — journald records service stdout at `info`,
so the smoke's warning-free-journal check does not see them, and they are
worth recognizing rather than chasing. `failed check for fsverity
support` is the root filesystem answering that it has no fsverity;
containerd probes and continues. `failed to load cni during init` is the
CRI plugin reporting that `/etc/cni/net.d` is still empty — the image
ships the directory but no network, because a container network is
runtime state the CLI creates and removes, not image configuration.
nerdctl writes its bridge definition there the first time a container
needs one, and the CRI picks up the same directory.

## Sandbox and shared-resource boundary

`dev/` and `codex/` provide same-owner process sandboxing, not a general
rootless OCI host. They do not ship Docker, Podman, containerd, runc/crun,
subordinate-ID helpers or allocations, rootless networking, or a writable-layer
storage driver. Cgroup delegation and usable user namespaces are prerequisite
plumbing for a future runtime composition, not evidence that arbitrary
devenv/container images work today.

`container-host/` is that runtime composition, and it is a *rootful* one:
containerd runs as root, sandboxes are started by root-side systemd
units, and the socket handed to uid 1000 is root-equivalent by
construction. It ships no subordinate-ID helpers either — rootless
containers need setuid `newuidmap`/`newgidmap`, which no minimos image
will carry — so it is not a way to give an untrusted user containers.
Its boundary is gVisor around the *workload*, not around the operator.

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
