# minimos examples

Worked compositions on the minimos base, roughly in order of complexity.
Copy the closest one to start. Each is a complete package with BUILD,
PACKAGE, keep and deny lists, units and config.

| example           | shows                                                 | image target              |
| ----------------- | ----------------------------------------------------- | ------------------------- |
| `memcached/`      | one culled binary and one unit that carries its flags | `:minimos-memcached`      |
| `valkey/`         | a config file, a state directory, a CLI for checking  | `:minimos-valkey`         |
| `nginx/`          | static content on several HTTP ports                  | `:minimos-nginx`          |
| `dev/`            | an interactive userland and a lingering user manager  | `:minimos-dev`            |
| `codex/`          | a GitHub release binary added to the dev image        | `:minimos-codex`          |
| `container-host/` | containerd with gVisor as the only OCI runtime        | `:minimos-container-host` |

Every `minimos.image()` emits `<name>`, `<name>-docker` for `docker load`,
and `<name>-boot-smoke`, so

```
buck2 test //src/images/minimos/examples/...
```

boots each one under docker and checks that systemd reaches `running`
with the example's service active. See the top-level README for what the
boot smoke does and doesn't cover.

## Trying one out

Locally:

```
buck2 test //src/images/minimos/examples/memcached:minimos-memcached-boot-smoke
```

On exe.dev, push under a fresh tag each time. exe.dev caches what a tag
resolved to for up to a day, so reusing a tag can boot the old image.

```
TAG=ttl.sh/$USER-minimos-memcached-$(date +%s):1h
docker load < $(buck2 build //src/images/minimos/examples/memcached:minimos-memcached-docker --show-full-simple-output)
docker tag minimos-memcached:latest $TAG
docker push $TAG
ssh exe.dev new --image=$TAG --name=mos-memcached
ssh mos-memcached.exe.xyz   # bash, systemctl and journalctl, no coreutils
```

Checking the appliance images from inside, without coreutils:

- memcached: `exec 3<>/dev/tcp/127.0.0.1/11211; printf 'version\r\n' >&3; read -r v <&3; echo "$v"`
- valkey: `valkey-cli ping` prints `PONG`
- nginx: open `https://<vm>.exe.xyz/` from anywhere

The dev and Codex images have coreutils, so check them like any machine:
`systemctl --user is-system-running`, `loginctl list-users`,
`git --version`, `codex --version`.

## dev/ and codex/: machines, not appliances

memcached, valkey and nginx are appliances, one service and no shell
tools. `dev/` is a machine to work on. It adds coreutils, findutils,
grep, sed, gawk, tar, gzip, xz, git, jq, ripgrep, procps, less, curl and
bubblewrap from pinned Wolfi packages, and runs `systemd --user` for
uid 1000.

exedev lingers, so logind starts `user@1000.service` at boot, and a
small culled layer brings back `systemd-user-runtime-dir` and
`loginctl`, which the base denies. The base already has the
`user@.service` drop-ins that clear `PAMName=`, which a rootfs with no
PAM can't satisfy, and set `XDG_RUNTIME_DIR`, which pam_systemd would
otherwise set. They do nothing until an account lingers, and the
composition policy wouldn't let this layer add them anyway.

### Where SSH sessions run

The platform starts its SSH listener before PID 1, so every SSH child
starts in `init.scope`. The dev overlay ships
`/etc/minimos/require-user-scope`, which makes exedev's login wrapper
start each shell or command with `systemd-run --user --scope`, under
`user@1000.service`. If the user bus isn't up, the wrapper refuses the
login rather than run it unbounded. It also turns off `systemd-run`'s
`$` expansion, so Bash sees the SSH command exactly once.

Each scope gets CPU and I/O weight 100, `MemoryHigh=65%`,
`MemoryMax=75%`, no swap and 2048 tasks, and delegates
`cpu cpuset io memory pids` so builds and runtimes can divide it
further. All of that sits under `user.slice`'s 70%/80% memory, 3072
tasks, and root-disk ceilings of 500 MB/s read, 250 MB/s write, 50K
read IOPS and 25K write IOPS. The user manager has its own defaults too,
with accounting on, 2048 tasks per service, a 30-second stop timeout and
no core files.

This only covers what comes in through the login shell. exe.dev's SFTP
handler doesn't use the account's shell, so SFTP sessions stay in
`init.scope`, outside `user.slice`'s memory and I/O ceilings, with only
its 512-task cap. Capping all of `init.scope` would also cap PID 1 and
the SSH listener, so the fix belongs on the platform side, which would
need to put each SFTP or forwarding handler in a bounded user scope.
Until then, treat those channels as a known gap in the resource limits.

### The dev boot smoke

`boot_smoke_userland = True` waives the no-coreutils check and nothing
else. Package managers, file modes and the baked accounts are still
checked. `boot_smoke_dev = True` checks the user manager, the login
scope's cgroup and accounting, the zero core limits, and that bubblewrap
is installed. Docker's seccomp policy blocks bubblewrap's `pivot_root`,
so a working bubblewrap sandbox has to be checked on a VM.

### codex/

`codex/` adds OpenAI's Codex CLI to the dev image, as the static musl
binary from a pinned GitHub release at `/usr/local/bin/codex`, with
`~/.codex/config.toml` pointing at the `exe-chatgpt` provider. Create the
VM with exe.dev's `chatgpt` integration. That makes
`https://chatgpt.int.exe.xyz/v1` reachable from the VM and proxies it to
the owning account, so no API key is ever in the image. A tag with the
same name doesn't attach the integration. Codex's command sandbox uses
the image's bubblewrap and the user namespaces minimos keeps.

```
ssh exe.dev new --image=<pushed image> --name=agent --integration=chatgpt
ssh agent.exe.xyz
codex                              # interactive
codex exec 'summarize this repo'   # one-shot
```

The same provider works with any Codex install:

```
codex \
  -c model_provider=exe-chatgpt \
  -c 'model_providers.exe-chatgpt.name="exe-chatgpt"' \
  -c 'model_providers.exe-chatgpt.base_url="https://chatgpt.int.exe.xyz/v1"'
```

### What bubblewrap does and doesn't isolate

Bubblewrap limits what a process can see inside its namespaces. On a VM
it runs without setuid, through an unprivileged user namespace. Outside
the namespace the process is still uid 1000, so it's no boundary between
users who don't trust each other, and it can't hide anything its caller
mounts or connects into it. For sandboxes that share the owner's
resources:

- share named workspace directories rather than all of `/home/exedev`,
  and mount caches and sources read-only where possible
- keep `/run/user/1000/bus`, runtime sockets, SSH agents, `/exe.dev`,
  host devices, host cgroups, `.ssh`, `.codex` and unrelated repos out
- give each workload its own cgroup limits and a quota or separate
  volume, since cgroups don't stop a full disk
- treat network access to an attached exe.dev integration as a
  credential, even though its API key lives outside the VM

The dev and Codex images aren't rootless container hosts. They have no
Docker, Podman, containerd or runc, no subordinate-ID helpers or ranges,
no rootless networking and no storage driver. Cgroup delegation and user
namespaces are only groundwork. Workloads that don't trust each other
need separate users with separate storage, cgroups, user managers and
ID ranges, or separate VMs, and separate VMs are the only option these
images offer today.

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
IMAGE=docker.io/library/nginx:1.29-alpine@sha256:<digest>
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
asserts it is still there. Anything else that starts a container on this
runtime, as root on this image or on any other containerd host, needs
both flags:

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

`container-host/` is a *rootful* runtime composition:
containerd runs as root, sandboxes are started by root-side systemd
units, and the socket handed to uid 1000 is root-equivalent by
construction. It ships no subordinate-ID helpers either — rootless
containers need setuid `newuidmap`/`newgidmap`, which no minimos image
will carry — so it is not a way to give an untrusted user containers.
Its boundary is gVisor around the *workload*, not around the operator.
