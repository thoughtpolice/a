<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

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
| `k0s/`            | Kubernetes nodes that keep their state in S3          | `:minimos-k0s`            |

Every `minimos.image()` emits `<name>`, `<name>-docker` for `docker load`,
`<name>-push` for pushing to a registry, and `<name>-boot-smoke`, so

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

On exe.dev, push with the image's `-push` target and boot from the
digest it prints. exe.dev caches what a tag resolved to for up to a day,
and a digest can't go stale.

```
IMAGE=$(buck2 run //src/images/minimos/examples/memcached:minimos-memcached-push -- ttl.sh/$USER-minimos-memcached:1h)
ssh exe.dev new --image=$IMAGE --name=mos-memcached
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

The platform's SSH server starts before PID 1, so every SSH child
starts in `init.scope`. It looks up exedev's shell with
`getent passwd`, and starts the login wrapper that names with `-c` and
the command, or with `-l` for an interactive login. The dev overlay
ships `/etc/minimos/require-user-scope`, which makes the wrapper start
each shell or command with `systemd-run --user --scope`, under
`user@1000.service`. If the user bus isn't up, the wrapper refuses the
login rather than run it unbounded. It also turns off `systemd-run`'s
`$` expansion, so Bash sees the SSH command exactly once.

All of this hangs on the `getent` lookup. When it fails, the platform
runs the first `bash` on its own PATH instead, and every session runs
unbounded in `init.scope` with no `XDG_RUNTIME_DIR`. The docker boot
smoke starts the wrapper itself, so it checks the lookup separately.

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
the SSH server, so the fix belongs on the platform side, which would
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

## container-host/: an appliance that runs containers

containerd, the CNI plugins and iptables its networking needs, and
gVisor as the only OCI runtime. The image has no userland of its own, so
it keeps the appliance checks the dev images waive.

"Only runtime" describes the image's content, not its configuration. No
layer has runc, crun or `containerd-shim-runc-v2`, so nothing else can
start a container, and the boot smoke checks the built layers for them.
containerd's CRI plugin, the only place containerd has a server-side
default runtime, names `runsc`. Sandboxes are configured in
`/etc/containerd/runsc/config.toml`, which the gVisor shim reads when a
client sends no runtime options. nerdctl and ctr never send any, so that
file is the only place to configure every sandbox.

### Running a workload

Workloads are data, started by systemd. A layer stacked on this image
ships an env file

```
# /etc/minimos/containers/web.env
IMAGE=docker.io/library/nginx:1.29-alpine@sha256:<digest>
RUN_ARGS=--publish 80:80 --memory 256m --cpus 1
COMMAND=
```

and a `multi-user.target.wants/container@web.service` link to the
`container@.service` template. The next section explains why that's the
only way to start one.

The template enforces two things a workload can't skip:

- **`IMAGE` has to be pinned by digest.** An `ExecStartPre=` check fails
  the unit otherwise. Every other input to these images is pinned by
  hash, while a workload image comes from a registry at runtime, and a
  tag can move between the boot you tested and the boot that runs.
- **Container logs are capped** at `--log-opt max-size=16m max-file=3`,
  which `RUN_ARGS` can override. Cgroups limit memory, CPU and pids but
  not bytes written, so an unbounded log is the likeliest way to fill the
  disk. Pulled images are the other way, and nothing bounds them.
  containerd's garbage collector only removes unreferenced content, so
  `nerdctl rmi` and watching disk usage stay the owner's job.

### What the SSH owner can and can't do

`containerd.service` hands its socket to exedev after it starts, so
`ctr` over SSH can pull, list, inspect and control tasks. It can't start
a container, and no permission would change that:

- `nerdctl` decides it's rootless from `geteuid()` alone. As uid 1000 it
  looks for a rootless containerd that doesn't exist and exits.
- `ctr run` builds the OCI spec on the client side, which means reading
  `/var/lib/containerd/.../snapshots/<n>/fs`. That's root's, and on
  cgroup v2 the client would need `mount(2)` anyway.

So creating a container is a build-time act here, like creating a
service. Container CLIs assume they're root or have a rootless daemon,
and rootless containers need setuid `newuidmap` and `newgidmap`, which no
minimos image ships.

The socket handover still gives the owner a way to root. Anything that
can reach the socket can start a container that mounts the host
filesystem, the same trade as Docker's `docker` group. It's there
because a container host whose owner can't see what's running can't be
run at all. gVisor is the boundary under the workloads, since each one
runs on a userspace kernel instead of the host's syscalls.

### The annotation non-CRI clients need

gVisor's shim only connects a container's stdio to runsc when the OCI
spec has `io.kubernetes.cri.container-type=sandbox`. `newInit` sets
`p.Sandbox` from that annotation alone, and `Create` passes `opts.IO`
only when `p.Sandbox` is set. Without it the shim reads runsc's output
through a pipe the sandbox inherits and never closes, so `Create` blocks
forever. The sandbox logs `Watchdog.Start() not called within 30s`, the
task sits in `CREATED`, and nothing reports an error.

The CRI always sets the annotation, which is why Kubernetes never hits
this. `container@.service` passes it, and the boot smoke checks it's
still there. Anything else that starts a container on this runtime, as
root on this image or on any other containerd host, needs both flags:

```
nerdctl run --runtime=io.containerd.runsc.v1 \
    --annotation io.kubernetes.cri.container-type=sandbox \
    --rm docker.io/library/alpine:3 uname -a        # Linux ... 4.19.0-gvisor
```

### Checked on a real VM

Docker can't start a gVisor sandbox inside the boot smoke, so the smoke
checks the pieces: no other runtime, runsc runs, containerd's merged
config, the socket handover, the unit's annotation, digest and log
guards, and the `sleep` that published ports need. On an exe.dev VM
with a workload enabled:

- the container reports `Linux 4.19.0-gvisor`, gVisor's kernel rather
  than the host's
- CNI bridge networking works, with `nerdctl0`, a veth pair and outbound
  HTTP from inside the sandbox. That depends on the platform kernel
  having nf_tables built in, since minimos shuts off module loading, and
  it's why the image's `iptables` links point at the nft binary rather
  than Wolfi's legacy default
- `--publish` serves the container's port on the VM. nerdctl's OCI hook
  holds each published port with `sleep infinity`, found on PATH. The
  image has no coreutils, so it ships `sleep` as a short Bash script.
  Without one, every container with a published port fails to start
  with `cannot start the port reserver process`
- gVisor's KVM platform isn't available, since the VM has `/dev/kvm` but
  no working nested VMX, so sandboxes use systrap

Container cgroups live at `/sys/fs/cgroup/<namespace>/<id>`, outside the
base's slices. nerdctl refuses the systemd cgroup manager for any runtime
but runc, so the runtime config says cgroupfs too. Limit each workload
in its `RUN_ARGS` with `--memory`, `--cpus` and `--pids-limit`.

What manages them does live in a slice. Each container adds a gVisor
shim under containerd and a nerdctl client in its `container@` unit,
both multi-threaded Go. In `system.slice` they would share the 2048
tasks journald, dbus and logind need, so the image puts containerd and
every `container@` unit in its own `containers.slice` with room for 8192.

Two lines in containerd's log show up on a clean boot. journald records
them at `info`, so the boot smoke doesn't flag them.
`failed check for fsverity support` means the root filesystem has no
fsverity, and containerd carries on. `failed to load cni during init`
means `/etc/cni/net.d` is empty. The image ships the directory but no
network, and nerdctl writes its bridge definition there the first time a
container needs it.

The container host runs containers as root. containerd is root, systemd
units start the sandboxes, and the socket handed to uid 1000 is as good
as root. It ships no subordinate-ID helpers, so it can't give an
untrusted user containers. gVisor protects the host from the workloads,
not from the owner.

## k0s/: a Kubernetes cluster that keeps its state in S3

[k0s](https://k0sproject.io) is Kubernetes as one static binary. It
carries the API server, scheduler, controller manager, kubelet,
containerd, runc and iptables, and unpacks them under
`/var/lib/k0s/bin` when it starts, so the image adds that binary, T4,
Tailscale, curl and some configuration to the base. Every node runs a
controller and a worker together, with `--no-taints` so pods run on
all of them.

Cluster state lives in [T4](https://github.com/t4db/t4), a key-value
store that speaks the etcd v3 API. Each node runs it as `t4.service`,
and k0s uses it as an external etcd on loopback. T4 keeps a local
Pebble database, uploads its WAL segments and checkpoints to an S3
bucket, and elects a leader with a lock object there. The leader
streams its WAL to the other nodes, which forward their writes to it,
so the datastore needs no quorum and any node can lead. The bucket is
reached through an exe.dev S3 integration, which signs each request at
the edge. T4's S3 client refuses to start without keys, so it gets
placeholders, and the integration replaces its signature.

exe.dev VMs have no network between them, and every VM has the same
private address, so the nodes talk over Tailscale. An exe.dev
`tailscale` integration holds a Tailscale API token, and each node
mints itself a single-use, pre-approved, ephemeral auth key through it
at boot, so no node ever holds the token. `cluster.env` names both
integrations, the bucket and the cluster's folder.

### Building a cluster

Create the integrations once, attached to a tag the nodes carry. The
tailscale integration takes an API access token (`tskey-api-...`), not
an auth key:

```
printf %s "$TAILSCALE_API_TOKEN" | ssh exe.dev integrations add tailscale --name=tailscale --key=- --attach=tag:mos-k0s
```

The first node bootstraps the cluster, since its folder is empty. The
others join as controllers with a token from a running node, which
`k0s-join-token` makes as exedev, and a setup script writes it to
`~/k0s-join.token` before k0s first starts:

```
ssh exe.dev new --image=$IMAGE --name=k0s-1 --cpu=1 --memory=2GB --tag=s3-testing,mos-k0s
echo "echo $(ssh k0s-1.exe.xyz k0s-join-token) >~/k0s-join.token" |
    ssh exe.dev new --image=$IMAGE --name=k0s-2 --cpu=1 --memory=2GB --tag=s3-testing,mos-k0s --setup-script=/dev/stdin
ssh k0s-1.exe.xyz kubectl get nodes
```

A node with no certificates, no token and no T4 data of its own
won't start T4 when its folder already holds a cluster. k0s keeps the CA and every certificate
on each node's own disk, not in the datastore, so a second bootstrap
would write a cluster with a different CA over the first. Give each
cluster its own folder, and empty it before starting over.

### What the image changes from k0s's defaults

- **The owner gets the admin kubeconfig.** Nothing on the image can
  become root, and k0s keeps its kubeconfig in a root-only directory.
  `k0s-kubeconfig.service` writes a copy to
  `/var/lib/k0s-kubeconfig/admin.conf` for exedev's group, exedev's
  `~/.kube/config` links to it, and `/usr/local/bin/kubectl` runs k0s's
  built-in kubectl with it. That's cluster-admin for anyone who can log
  in, the same trade as the container host's containerd socket.
  `k0s token create` reads root-only state too, so `k0s-join-token`
  builds the same token from the cluster's public CA certificate and
  registers its bootstrap secret with kubectl.
- **Everything uses the tailnet address.** The start script renders
  `k0s.yaml.in` with the node's Tailscale address as the API address,
  T4's peer address, the kubelet's node IP and the interface Calico
  picks. eth0's address is the same on every VM.
- **Calico carries pods in VXLAN.** Tailscale only delivers packets
  addressed to tailnet nodes, so pod traffic between nodes goes in
  VXLAN between their tailnet addresses, with an MTU of 1230 to fit
  inside Tailscale's 1280. kube-router routes pod addresses directly,
  and IPIP isn't in exe.dev's kernel.
- **Calico's packet marks move.** Felix marks every packet from a pod
  with `0x80000` by default, and Tailscale routes packets marked
  `0x80000/0xff0000` around the tailnet, out eth0, so pods couldn't
  reach another node's kubelet or API server.
  `FELIX_IPTABLESMARKMASK=0xff000000` moves Felix's marks clear of
  Tailscale's and kube-proxy's.
- **Tailscale relays everything and leaves the firewall alone.** Left
  to probe, tailscaled offers peers every local address, and a peer
  that picked Calico's `vxlan.calico` address sent WireGuard into
  VXLAN, which runs over Tailscale, and the loop moved gigabytes until
  connections stalled. VMs can't reach each other directly anyway, so
  `TS_DEBUG_ALWAYS_USE_DERP` keeps all traffic on Tailscale's relays,
  which is a debug knob rather than a supported flag.
  `--netfilter-mode=off` keeps tailscaled's native nftables rules out
  of the tables `iptables-nft` shares with Calico, whose
  `iptables-nft-save` can't read them.
- **No konnectivity.** Every node is a controller on one tailnet, so
  each API server reaches kubelets and pods directly, and
  konnectivity's tunnels would only add a component.
- **Pods run in systemd's slices.** By default k0s's kubelet makes
  cgroups under `/kubepods`, beside systemd's tree, and moves itself
  into `/system.slice/containerd.service`, a cgroup no unit owns. The
  default worker profile selects the systemd cgroup driver and leaves
  the kubelet in `k0scontroller.service`, a containerd drop-in sets
  `SystemdCgroup = true` to match, and `--runtime-cgroups` names the
  unit containerd actually runs in. k0s itself runs in its own
  `kubernetes.slice`, beside `system.slice` and its 2048-task cap.

### What stays different on minimos

- The control plane runs as root. k0s runs the API server and the
  scheduler as their own accounts when they exist, and minimos's
  accounts are baked into the base, which a layer can't extend. k0s
  logs a warning for each and runs it as root. T4 runs as a transient
  systemd user with no capabilities, in a sandbox.
- k0s's preflight check wants `modprobe` and warns without it.
  Everything Kubernetes needs is built into exe.dev's kernel: overlayfs,
  bridge netfilter, VXLAN, ipset, IPVS and the xtables matches.
- exe.dev's smallest VM has 2 GB of memory. A settled node uses
  1.3 to 1.5 GB of it.
- The nodes join the integration token's tailnet as untagged devices
  owned by its user, so they can reach that user's other devices, and
  those devices can reach them. A tag and an ACL would fence them off.

### Why T4 runs on its own

k0s 1.36.4 bundles kine 0.16.5, whose T4 driver uses t4 1.0.6, and in
that version a lost leader went wrong twice. Followers set no gRPC
keepalives, and a deleted tailnet node drops packets rather than
resetting connections, so they noticed only when TCP gave up after
about 16 minutes. Then both followers took over at once, a write the
first had acknowledged never reached the second, and the two ended up
serving different data. t4 1.1.2 exchanges heartbeats between the
leader and its followers and fixes takeover catch-up, no kine release
uses it yet, and k0s unpacks its own kine at every start, so the image
runs t4 1.1.15's server itself.

With t4 1.1.15, followers miss a lost leader's heartbeats within 2
seconds and try to take over about 20 seconds later. One wins the lock
and the other follows it. The winner then catches up from the bucket
before it serves, which takes 20 seconds or more, while the follower
gives up after five failed connections, about 8 seconds, and takes over
as well. The first winner finds its lock superseded and fences itself.
The process stays up and answers every request with
`t4: node is closed`, while its health checks still pass.
`t4-watchdog.service` sends it a read every 15 seconds and restarts it
when it's fenced, and after the restart it follows the new leader.
T4's main branch makes a fenced node exit (t4db/t4#307), which no 1.1
release has yet.

Catching up means replaying every WAL segment since the last
checkpoint, one GET at a time through the integration. T4 checkpoints
every 15 minutes by default, and a takeover 14 minutes after one took
over a minute, so `t4-start` sets the interval to one minute.

### Checked on real VMs

Three exe.dev VMs with 1 vCPU and 2 GB each reach `Ready` about three
minutes after the first one starts. From a pod on each node, a pod on
every node, a service by name, and every node's kubelet and API server
all answer. `kubectl logs` and `exec` reach pods on every node,
`kubectl top` reports all three, the `kubernetes` service lists all
three API servers, and T4 streams the WAL from its leader to the
others and into the bucket.

Deleting the T4 leader's VM while writing ConfigMaps through a
follower, writes failed for 48 to 74 seconds with one-minute
checkpoints, and for 100 to 131 seconds with T4's default. In all four
runs both survivors took over in turn, and the watchdog restarted the
one that fenced itself. Afterwards both survivors held exactly the
writes that had been acknowledged, with the same resource versions. A
new node joined with a token from a survivor in one to two minutes,
restored T4 from the bucket's checkpoint, and passed the same network
checks.
