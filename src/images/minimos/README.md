# minimos

minimos is a small appliance-style OCI image for exe.dev VMs, in the
spirit of Bottlerocket. It boots systemd and runs services, and not much
else. There's no distro userland, no coreutils, no package manager and
no SSH daemon, since the platform brings its own sshd. The base is
systemd and its libraries, the few `/etc` files it needs, `bash`, `dash`
and `nologin` for the platform's login contract, and `chronyd`, because
a wrong clock breaks certificate checks, token lifetimes and log order.

Everything comes from pinned [Wolfi](https://wolfi.dev) packages. The
build downloads hash-checked `.apk` files (see
`third-party//by-name/wo/wolfi`), extracts them with a small stdlib
Python tool, and culls the result. There's no donor image, no `apk` at
build or run time, and nothing unpinned. Updating the OS means bumping
versions and hashes in one BUILD file and passing the boot smokes.

This package builds the two base layers. Other packages stack services
on them with the macros in `defs.bzl`.

## Layout

```
src/images/minimos/
  BUILD            the base layers and the :minimos reference image
  defs.bzl         minimos.apk_culled_layer, minimos.overlay, minimos.image
  policy.txt       what a layer above the base may write
  base/
    keepfiles.txt  paths the base keeps from the Wolfi rootfs
    denyfiles.txt  paths it drops again
    config/        /etc and /usr/lib/minimos files
    units/         systemd units and drop-ins
  tools/           cull, overlay, image and boot smoke tools
  examples/        worked compositions, see examples/README.md
    memcached/     one binary and one unit, the smallest
    valkey/        a config file, a state directory, a CLI
    nginx/         static content on several ports
    dev/           an interactive userland and a user manager
    codex/         the dev image plus the Codex CLI
    container-host/  containerd with gVisor as the only runtime
```

## Composing an image

One load gives a package everything:

```bzl
load("@root//src/images/minimos:defs.bzl", "minimos")

# Cull the service and the libraries it links out of pinned Wolfi
# packages, per keepfiles.txt in this package. Pin new packages in
# third-party//by-name/wo/wolfi first. The .so closure resolves against
# the base, so list only what the base doesn't ship.
minimos.apk_culled_layer(
    name = "app-culled-layer",
    apks = ["app", "libapp-deps"],
)

# Config, units and content, declared rather than scripted.
minimos.overlay(
    name = "app-overlay-layer",
    dirs = ["etc", "var", "var/lib/app"],
    files = {"etc/app.conf": "app.conf"},
    units = ["app.service"],  # enabled per its [Install] section
)

# The base layers go first and yours on top. This emits my-app,
# my-app-docker and my-app-boot-smoke.
minimos.image(
    name = "my-app",
    description = "minimos + my app",
    layers = [":app-culled-layer", ":app-overlay-layer"],
    ports = ["80/tcp"],
    boot_smoke_units = ["app.service"],
)
```

A service with no Wolfi package needs one pinned or built from source.
There's no way to cull a foreign image, so every binary shares the
base's glibc.

`minimos.image` bakes in the exe.dev boot contract. The Cmd is
`/sbin/init --log-target=syslog --show-status=true --log-color=false`,
the user is root, the environment sets `PATH`, `LANG=C.UTF-8`,
`TERM=dumb` and `SYSTEMD_COLORS=0`, and the `exe.dev/login-user` label
names `exedev`.

It also enforces the composition policy in `policy.txt` on every layer
above the base. A layer can add paths under the composable prefixes, but
it can't redefine anything a lower layer set up. The error messages map
to the rules like this:

- `writes /..., which is not under a composable path`: the path is
  outside the prefixes `policy.txt` opens, or inside one it seals.
- `replaces /..., which a lower layer established`: two layers ship the
  same path. Usually a keep list matched something the base already has,
  or two overlays write the same file. A culled layer's .so closure never
  causes this, because it leaves out what the base carries.
- `which reconfigures X, a unit that already exists below this layer`:
  an overlay tried to override, mask or drop in a file for a unit it
  didn't ship. Configure your own units only.
- `which a lookup by name can run instead of /usr/bin/X`: a program has
  the same name as one a lower layer ships in another PATH directory.
  Rename it or leave it out.
- `no layer declares its parent directory`: add the directory to `dirs`.

## Running on exe.dev

Build, push under a fresh tag, and boot. Run buck2 from the repository
root, because `--show-full-simple-output` prints nothing from elsewhere.

```
TAG=ttl.sh/$USER-minimos-$(date +%s):1h
docker load < $(buck2 build //src/images/minimos:minimos-docker --show-full-simple-output)
docker tag minimos:latest $TAG
docker push $TAG
ssh exe.dev new --image=$TAG --name=minimos-test
ssh exe.dev vm-logs minimos-test   # the console, even when SSH fails
ssh exe.dev rm minimos-test
```

The same steps work for every example with its own target and image
name. What the platform expects from a custom image:

- **The Cmd has to be named `init`.** exe.dev's own init decides by file
  name whether to exec a Cmd as PID 1 or run it as a child. `/sbin/init`
  qualifies, and `minimos.image` fails the build for a `cmd` that doesn't
  start with a program named `init`.
- **The HTTPS proxy waits for SSH.** After boot the platform tries SSH
  logins as `root` and as the `exe.dev/login-user` account, and the proxy
  answers 503 until one works. The platform sshd maps every login name,
  root included, to `exedev` (uid 1000). It refuses an account whose
  shell doesn't exist, so the image ships the login wrapper, Bash, dash
  as `sh`, and `nologin`, even though root never logs in.
- **The platform brings its own sshd.** exe-init mounts `/exe.dev` with a
  musl sshd, its host keys, authorized_keys and config, starts it outside
  systemd, and then execs the Cmd. The image needs no OpenSSH, PAM or
  crypto libraries for SSH.
- **The proxy picks a port from ExposedPorts.** It takes 80 if the image
  lists it, and otherwise the lowest listed port from 1024 up. With no
  ports it uses 80. `ssh exe.dev share port <vm> <port>` overrides it.
- **Mutable tags are cached.** exe.dev remembers what a tag resolved to,
  for an hour for `latest`, `main` and `master` and a day for any other
  tag. A VM created soon after a push can boot the old image, so push
  each build under a new tag or use its digest.
- **The root filesystem grows at boot.** A new VM's filesystem already
  fills its disk, but `resize` only grows the block device. exeuntu grows
  the filesystem with an `x-systemd.growfs` line in `/etc/fstab`. minimos
  has no fstab, so the base links `systemd-growfs-root.service` into
  `local-fs.target`, with a drop-in that skips it under docker. It runs
  on every boot and does nothing while `/` already fills the disk.
- **Setup scripts run as exedev, and may run again.**
  `exe-setup.service` runs `/exe.dev/setup`, the `--setup-script` given
  to `new`, as exedev with no capabilities and a read-only system. It can
  set up `/home/exedev` and nothing else, so system changes belong in the
  image. exe.dev's docs say the script runs once at first boot, but the
  platform writes it back on every boot and the unit runs it again, so
  make it safe to run twice. The unit deletes the file after each run,
  so secrets in it don't stay on disk.
- **Ship `mount(8)`.** `.mount` units run `/usr/bin/mount`, and without
  it the boot ends `degraded` on a VM. Docker hides this by mounting
  `/dev/mqueue` itself.
- **Ship the C.UTF-8 locale.** The Cmd environment sets `LANG=C.UTF-8`
  and systemd passes it to every unit. Without `/usr/lib/locale/C.utf8`
  from Wolfi's `glibc-locale-posix`, `setlocale()` fails, and some
  daemons, valkey for one, exit.
- **The platform writes `/etc/resolv.conf` and `/etc/hosts`.** At boot
  exe.dev replaces both, pointing DNS at `169.254.169.254` and adding the
  VM's own name to `/etc/hosts`. The base still bakes both, with
  `1.1.1.1` as the resolver, for docker and in case the platform stops
  writing them. Platform names such as `chatgpt.int.exe.xyz` are in
  public DNS too.
- **Don't bake `/etc/hostname`.** Each VM's name comes from the kernel
  command line, and a baked file would give every VM the same name.
- **Time comes from `/dev/ptp0`.** Every VM has a KVM virtual PTP clock,
  created by devtmpfs with no udev, and it needs no network or module.
  There's no RTC (`timedatectl` shows `RTC time: n/a`), so chrony has no
  `rtcsync`.
- **The disk doesn't support discard.**
  `/sys/block/vda/queue/discard_max_bytes` is 0, so there's no
  `fstrim.timer`.
- **The console is a log, not a terminal.** `ssh exe.dev vm-logs` shows
  systemd's status lines and the platform sshd's errors, and works when
  SSH doesn't. systemd 256 and later also write terminal escapes unless
  `TERM` is dumb, which is why the image environment sets `TERM=dumb`
  and `SYSTEMD_COLORS=0` on top of `--log-color=false`. SSH sessions get
  their own `TERM` from the platform sshd.

Logging in with `ssh <vm>.exe.xyz` lands in exedev's login wrapper.
Appliance images give you Bash with core dumps off, and Bash builtins
plus `systemctl` and `journalctl` are enough to look around. Dev images
refuse the login unless the wrapper can place Bash in a bounded user
scope, as `examples/README.md` explains.

## Security and hardening

The threat model is trusted workloads on a single-owner VM. The base is
hardened against a compromised service and against abuse of the
kernel's interfaces, not against the VM's owner or between tenants who
don't trust each other. Bottlerocket rests on a dm-verity root, an
enforcing SELinux policy and a signed kernel. None of those exist with a
platform-provided kernel and a writable ext4 root, so minimos leans on
two things Bottlerocket barely uses, runtime sysctls and per-unit
systemd sandboxing, whose directives Bottlerocket's units don't use.

What the base enforces:

- **No setuid, setgid or world-writable files**, sticky directories
  aside. `mkapkroot.py` and `cull.py` both drop the setuid bits Wolfi
  ships on `mount` and `umount`, `mkoverlay.py` refuses such modes, and
  every boot smoke fails if a layer has one.
- **Layers above the base write only where they're allowed to.** A
  composition layer can't redefine any of the base's paths, write a
  drop-in for a whole unit type such as `service.d`, or add a unit file,
  mask, alias or drop-in in `/etc/systemd/system` for a unit a lower
  layer defines. It can still enable one with a `.wants/` link. It can't
  add a program under a name a lower layer uses in another PATH
  directory, so no `/usr/local/bin/mount`. A new path must sit under a
  composable prefix and outside every sealed one, which carve out
  identity files, `ld.so` hooks, every sysctl, tmpfiles, sysusers and
  modules directory, systemd's configuration and higher-priority unit
  paths, generators, bus policy and trust roots. Anything the policy
  doesn't open is refused, so a search path nobody thought of stays
  closed. `scratch_image.py` enforces this at build time, and
  `tools/security_tests.py` tests it against the shipped `policy.txt`.
- **Accounts are baked.** `/etc/{passwd,group,shadow}` come from
  `base/config/` alone. `sysusers.d` is culled, `systemd-sysusers` is
  masked, and the boot smoke checks the files don't change at boot.
  Every account is locked, and there's no PAM, login(1) or sudo.
- **No login reaches uid 0.** root is locked with `nologin`, and every
  SSH login lands in `exedev`, whose password is locked too. Its shell,
  `/usr/lib/minimos/login-shell`, sets `umask 077`, turns off core dumps
  and starts Bash. There's no sudo, su, polkit or setuid helper, so
  changing the system means rebuilding the image. exedev is in
  `systemd-journal` so the owner can read logs. journald creates
  `/var/log/journal/<machine-id>` as root:root without the parent's
  setgid group, so `/etc/tmpfiles.d/systemd.conf` fixes the group, and
  the boot smoke checks the group can read the journal.
- **Sysctls come in two tiers.** Everything in the automatic search path
  is scoped to a network namespace, so booting the rootfs under docker
  can't change the host kernel. That's why systemd's own
  `50-default.conf`, `50-pid-max.conf` and `50-coredump.conf` are denied
  and their network half restated in `60-minimos-hardening.conf`. That
  file also refuses redirects and router advertisements, turns on
  syncookies, and puts `ip_unprivileged_port_start` back to 1024, so a
  service that needs a low port gets `CAP_NET_BIND_SERVICE` in its own
  unit. The host-global keys live in `/usr/lib/minimos/sysctl-vm.conf`,
  outside the search path. `minimos-harden.service` applies them during
  `sysinit.target`, turning off module loading, restricting dmesg,
  kernel pointers, unprivileged BPF and io_uring, applying KSPP
  filesystem and tty settings, turning off suid core dumps and sysrq,
  rebooting on an oops, and capping inotify, memory maps and namespace
  counts. The unit is gated `ConditionVirtualization=!container` rather
  than `=vm`, so a hypervisor systemd can't identify still gets
  hardened. `systemd-sysctl` carries on past a key it can't set, so the
  unit reads `kernel.modules_disabled` back and fails if it isn't 1.
- **A control-plane/workload QoS hierarchy.** PID 1 and the platform SSH
  listener remain in `init.scope`; normal system services use `system.slice`.
  Both request CPU/I/O weight 1000, a 10% memory low-watermark, and finite task
  ceilings (512 and 2048 respectively). `user.slice` receives weight 100,
  `MemoryHigh=70%`, `MemoryMax=80%`, no swap, and `TasksMax=3072`. It also
  carries aggregate root-filesystem `io.max` ceilings: 500 MB/s reads,
  250 MB/s writes, 50K read IOPS, and 25K write IOPS. systemd resolves `/` to
  the actual backing device, so this does not assume an undocumented device
  name.
  `user-workload.slice` is a child of `user.slice`, with a tighter 65%/70%
  memory policy, no swap, and `TasksMax=2048` for application units that
  explicitly select it; `exe-setup.service` does so and has tighter per-unit
  limits. Application services and interactive scopes therefore share the
  parent 80% memory and 3072-task aggregate ceiling instead of being separate
  overcommitted top-level classes. CPU weights are relative contention
  priorities, not hard quotas. I/O weights are likewise best-effort and need a
  kernel/device scheduler that exposes `io.weight`; exe.dev's current
  weightless virtio stack does not, so the aggregate bandwidth/IOPS ceilings
  are the enforced disk-I/O boundary there. A composed service stays in
  `system.slice` unless its unit opts into the workload slice and supplies any
  service-specific ceilings it needs.
- **The base's own services are sandboxed, not just composed ones.** journald
  and logind ship upstream hardening blocks; Wolfi's `dbus.service` ships none
  at all, and it is the one always-on service every local uid can reach. A
  base drop-in gives it the same block the examples use — `ProtectSystem=strict`,
  `PrivateTmp=`, `ProtectProc=invisible`, `CapabilityBoundingSet=CAP_AUDIT_WRITE`,
  `RestrictAddressFamilies=AF_UNIX`, `SystemCallFilter=@system-service` — with
  `RuntimeDirectory=dbus` for the socket.
- **Bus policy states the deny that systemd currently only implies.** The
  vendor policy lets any uid *send* `StartUnit`, `StartTransientUnit`,
  `MaskUnitFiles` and friends to PID 1, commented "Managed via polkit or other
  criteria"; minimos ships no polkit, so the refusal rests entirely on
  systemd's fallback for an unreachable authority. It works — an unprivileged
  `StartUnit` is denied — but it is one mechanism, and it changes meaning the
  day a container runtime pulls polkit in. `/etc/dbus-1/system.d/50-minimos-deny.conf`
  denies the manager interfaces outright and re-allows the read-only surface
  `systemctl status`/`journalctl` need. Cgroup delegation is the one exception:
  a per-user manager asks PID 1 to `AttachProcessesToUnit` for a scope it owns,
  and systemd authorizes that against the unit's owning uid rather than via
  polkit, so denying it would break the dev images' bounded login scopes
  instead of closing a hole.
- **An account exists only if something runs as it.** The baked files
  define root, three Wolfi skeleton accounts, `systemd-journal`,
  `messagebus`, `chrony`, `exedev` and `nobody` — that is the whole
  identity surface. `systemd-network`, `systemd-resolve` and
  `systemd-timesync` were removed once their daemons were culled and
  chrony took over the clock; the only files still naming them were bus
  policies and tmpfiles for services this image does not have, which are
  denied in the same breath. The rule cuts both ways, and the boot smoke
  is where it is enforced: a vendor config that names an account the
  image lacks fails the boot loudly (`Failed to resolve user
  'systemd-network'`) rather than leaving a directory unowned.
- **No hardware watchdog, and no pretending otherwise.** exe.dev VMs
  expose no `/dev/watchdog` (there is no `/sys/class/watchdog` either),
  so systemd's `RuntimeWatchdogSec=` has nothing to arm, and neither
  containerd nor chronyd implements the `sd_notify` watchdog protocol —
  a `WatchdogSec=` on them would kill working daemons on a timer. What
  covers the same ground here is `kernel.panic_on_oops=1` plus
  `kernel.panic=10` in the VM-only sysctls (reboot rather than limp), and
  per-unit `Restart=`/`Timeout*Sec=`. If a future platform grows a
  watchdog device, arming it is a two-line change to
  `system.conf.d/minimos-overrides.conf`.
- **Nothing outside the image provisions the image.** `provision.conf` (which
  writes `/etc/hosts` and `/root/.ssh/authorized_keys` from SMBIOS/fw_cfg/
  cmdline credentials), `static-nodes-permissions.conf` (which chmods
  `/dev/{fuse,net/tun,kvm,vhost-*}` to 0666), and the `systemd-run` and
  `systemd-debug` generators (which turn `systemd.run=` and
  `systemd.extra-unit.*` into root-executed units ahead of everything in
  `/etc/systemd/system`) are all denylisted. Configuration changes are image
  rebuilds, for the same reason `sysusers.d` is culled.
- **The clock has one source, and it is not the network.** exe.dev VMs
  expose `/dev/ptp0`, the KVM virtual PTP clock — a paravirtual device that
  reads the host's clock through a hypercall. chrony takes its time from
  that and nothing else: no `server`, no `pool`, and `PrivateNetwork=yes`
  on the unit so the config cannot quietly grow one. The alternative would
  be unauthenticated UDP from a public pool, because Wolfi builds chrony
  without NTS (`-NTS` in its feature line), and time is not a low-stakes
  input — it decides whether an expired certificate looks valid.
  `chronyd` also demonstrates what a privileged daemon looks like here: it
  starts as root only because it checks `geteuid()` rather than its
  capabilities, immediately drops to uid 106 with its own `+PRIVDROP`
  support, and ends up holding `CAP_SYS_TIME` and nothing else
  (`CapEff: 0000000002000000` on a running VM), with no supplementary
  groups, a seccomp filter, no network namespace, and `DevicePolicy=closed`
  admitting exactly one character device. The bounding set carries
  `CAP_SETUID`/`CAP_SETGID` purely so that drop can happen — `setgroups()`
  needs `CAP_SETGID` even for uid 0. Under `docker` the unit is
  condition-gated off entirely: a container shares the host's clock, and
  disciplining it from inside would be both futile and hostile.
- **No coredump machinery**: `systemd-coredump` is culled, its
  `core_pattern` sysctl denied, `DumpCore=no` + `DefaultLimitCORE=0`
  set globally; the persistent journal is capped at 64M.
- **Deliberate divergences from Bottlerocket.** User namespaces remain
  available, with finite VM-only object-count ceilings, so unprivileged
  bubblewrap works and a future rootless-runtime composition remains possible.
  There is no global `NoNewPrivileges=` because a future container runtime may
  need controlled privilege transitions; individual services set it through
  their sandbox policy.
- **Where a container runtime fits.** `examples/container-host` is the
  Bottlerocket-shaped composition: containerd with gVisor as the only OCI
  runtime present, so a container cannot be started outside a userspace
  kernel — there is no runc, crun, or runc shim in any layer to start one
  with. It also makes the one divergence this base cannot express on its
  own: containerd's control socket is handed to uid 1000, which is
  root-equivalent access, because a container host whose owner cannot see
  what is running is not administrable. Everything else in that image —
  baked accounts, no setuid, no package manager, the composition policy —
  holds unchanged. See its section in [examples/](examples/README.md) for
  what the owner can and cannot do, and for the gVisor shim behavior that
  makes the CRI sandbox annotation mandatory for non-CRI clients.

Hardening a composed service: copy the sandbox block from an example
unit — `valkey.service` is the canonical one. The shape: `DynamicUser=`
(which implies `NoNewPrivileges`, `ProtectSystem=strict`,
`PrivateTmp`, `RemoveIPC`,
`RestrictSUIDSGID`), `StateDirectory=`/`LogsDirectory=`/
`RuntimeDirectory=` instead of hand-made `/var` dirs, an empty
`CapabilityBoundingSet=`, the `Protect*`/`Restrict*` block,
`SystemCallFilter=@system-service`, and — for loopback-only services —
`IPAddressDeny=any` + `IPAddressAllow=localhost`. Trim only what your
service demonstrably needs (e.g. drop `MemoryDenyWriteExecute=` for a
JIT).

Interactive images (`examples/dev` and `examples/codex`) relax exactly one
image-content rule: they ship a userland, so their boot smokes pass
`boot_smoke_userland = True` to waive the no-coreutils layer check. The package
manager, account, mode, and privilege-escalation invariants remain.

The dev overlay also creates `/etc/minimos/require-user-scope` and a lingering
`user@1000.service`. Because the platform SSH listener starts before PID 1, an
SSH child initially inherits `init.scope`; the exedev login wrapper therefore
uses `systemd-run --user --scope` for both interactive shells and SSH commands.
It refuses the login instead of running it unbounded if the user bus is not
ready. Each resulting scope delegates `cpu cpuset io memory pids`, has CPU/I/O
weight 100, `MemoryHigh=65%`, `MemoryMax=75%`, no swap, and `TasksMax=2048`, all
under the aggregate `user.slice` ceiling. This covers processes that enter
through the configured login shell; a new platform subsystem that bypasses
that shell needs its own placement test and policy.

The user manager has separate defaults for I/O/memory/task accounting, a
2048-task default, a 30-second stop timeout, and a zero hard core-file limit.
The login wrapper disables `systemd-run`'s pre-execution `$` expansion before
passing an SSH command to Bash, so shell syntax is interpreted exactly once in
the bounded scope.

The current exe.dev SFTP subsystem is a confirmed exception: its authenticated
uid-1000 handler does not invoke the account shell and remains in
`init.scope`. It therefore misses the user-slice memory and disk-I/O ceilings
and inherits control-plane priority, though the init-scope 512-task ceiling
still applies. Do not solve this by putting a blunt memory maximum on
`init.scope`, because PID 1 and the platform listener share it. A production
devenv-host integration needs exe.dev to place each authenticated SFTP or
forwarding data handler in a bounded user scope. Until then, treat those
channels as an acknowledged QoS bypass, not a tenant boundary.

### Development sandbox and shared-resource boundary

Bubblewrap is present for same-owner process sandboxing, including Codex's
Linux command sandbox. On a real VM it runs without setuid by using an
unprivileged user namespace. That is useful containment, but it is not a tenant boundary: the
process still belongs to host uid 1000 outside the namespace, and any home
directory, socket, device, or credential deliberately exposed to it remains a
same-owner capability. The Docker boot smoke verifies bubblewrap installation;
the real-VM test must verify namespace and mount startup. Neither check
certifies every caller's mount, network, seccomp, or file-access policy.

The dev and Codex images are **not general rootless OCI container hosts**.
They contain no Docker/Podman/containerd/runc-style runtime, subordinate-ID
mapping helpers, `/etc/subuid` or `/etc/subgid` allocation, rootless networking,
or writable-layer storage driver. Keeping user namespaces and cgroup delegation
available is prerequisite plumbing, not an implemented container runtime.

For a same-owner devenv or sandbox that shares host resources:

- expose explicit workspace paths rather than `/home/exedev`; use read-only
  mounts for source caches and other inputs unless writes are necessary;
- do not pass `/run/user/1000/bus`, a future container-runtime socket, an SSH
  agent, `/exe.dev`, host devices, or the host cgroup tree into a sandbox;
- keep `.ssh`, `.codex`, integration state, and unrelated repositories outside
  shared mounts, and treat access to an exe.dev integration endpoint as an
  authorization capability even though its upstream key is not stored in the
  VM;
- apply per-workload cgroup limits plus a filesystem quota or dedicated volume;
  memory/PID/I/O cgroups do not stop an image store, log, or workspace from
  filling the root filesystem.

Mutually untrusted workloads need distinct host identities with disjoint
storage, user managers, cgroups, and subordinate-ID ranges, or separate VMs.
The shipped images define only the single `exedev` owner, so separate exe.dev
VMs are the available strong boundary without building an additional
multi-user/runtime composition.

## Tools

All generic machinery lives in `tools/` and is only reached through the
`defs.bzl` macros:

- `mkapkroot.py` extracts apk v2 packages (three concatenated gzip tar
  streams; the dotfile control entries are skipped) into a rootfs
  directory — package installation as deterministic extraction, no
  apk-tools involved.
- `cull.py` consumes the exact rootfs path (assembled from apks via
  `assemble_and_cull.sh`) and emits a tarball containing only the
  allowlisted paths plus the recursive `.so` closure of every kept ELF
  binary. The closure is resolved against the layers below first
  (`--provided-rootfs`, the base's culled layer for every composition),
  so a library the base ships is never copied and a composition lists
  only the packages it adds. It fails on sonames it cannot resolve — Wolfi builds
  systemd's optional deps behind dlopen, so keepfiles.txt names the
  dlopen'd libraries we choose to ship and the check catches their missing
  DT_NEEDED tails. It never guesses that a child named `rootfs` is a bundle
  root, charges repeated hardlink paths against the expanded-content budget,
  and atomically publishes only a complete bounded tar.
- `mkoverlay.py` builds a deterministic overlay tar from CLI declarations
  (dirs, files, symlinks, systemd units, masks; files and dirs take
  optional mode/uid/gid) — this is what makes `minimos.overlay()`
  possible without per-image Python. A unit is enabled the way
  `systemctl enable` would do it offline, from its own `[Install]`
  section. Inputs are descriptor-snapshotted and bounded; a failed
  build preserves any prior output.
- `scratch_image.py` assembles a fresh single-manifest OCI layout from
  layer tars — we can't use `oci_image` because it preserves base-image
  layers, and we want none. Before atomic publication it revalidates
  `oci-layout`, schema/media versions, every descriptor size and digest,
  config diff IDs, compression, effective cross-layer paths/types, and the
  composition policy described above.
- `boot_smoke.sh` backs the per-image `<name>-boot-smoke` test. Before loading
  or executing an image, it scans the layers for package managers, unexpected
  appliance userland, setuid/setgid bits, and non-sticky world-writable paths.
  It then boots systemd with a private cgroup namespace, no network, bounded
  memory/CPU/PIDs/logs/tmpfs, `no-new-privileges`, and an explicit capability
  set instead of Docker `--privileged`. Skopeo, container exec/log reads, and
  cleanup are bounded by timeouts. The pre-load validator receives the same
  base-layer count and composition policy as construction, so it independently
  re-attests those semantics. The runtime checks
  require systemd to reach `running`, zero failed units, image-specific units,
  plain console output, unchanged baked account files, and a warning-free boot
  journal — the place where a silently-ignored hardening directive, or a vendor
  config naming an account the image does not have, would otherwise hide behind
  a successful boot. It also asserts the `systemd-journal` group can read the
  system journal, because journald does not arrange that itself. Four lines
  are tolerated, each matched anchored and whole and justified in the script:
  one is an artifact of Docker's overlay root having no originating block
  device (the same reason the `io.max` realization check defers to the VM);
  one is the user manager re-arming a PSI trigger, which the kernel refuses
  one-per-descriptor and systemd ignores — this one occurs on a real VM too,
  with the io controller present and delegated; and two are systemd noting
  that libbpf and libkmod are absent. Those last two are deliberate rather
  than gaps. Without libbpf, `SocketBind*=`, `RestrictNetworkInterfaces=` and
  `RestrictFileSystems=` are unavailable (the platform kernel has no BPF LSM
  for the last one anyway), while `IPAddressDeny=`/`IPAddressAllow=` use raw
  `bpf()` syscalls and were verified enforcing on a VM: a loopback connect is
  refused under `IPAddressDeny=any` and permitted once
  `IPAddressAllow=localhost` is added. libkmod is absent because module
  loading is latched off.

  On a real VM the journal additionally carries kernel-transport messages the
  image cannot influence (firmware/TSC notes, absent CPU features, mitigation
  reporting). "Warning-free" means no line the image is responsible for.
  Dev-image checks
  additionally exercise the login wrapper's cgroup placement, zero core limit,
  user manager, and bubblewrap installation. Docker's nested-container policy
  rejects bubblewrap's `pivot_root`, so functional bubblewrap isolation is an
  explicit real-VM integration check. Images built with
  `boot_smoke_userland = True` skip only the appliance-userland scan.

  This is a bounded integration test, not a sandbox for hostile images. PID 1
  still needs capabilities such as `SYS_ADMIN` inside its container, and runs
  without Docker's AppArmor profile: `docker-default` denies the mount
  propagation change systemd makes before running generators, so PID 1 cannot
  start under it. Seccomp and the capability bound stay in force. Run
  untrusted or adversarial image fixtures only on a disposable Docker host/VM,
  and use a real exe.dev VM to validate VM-only sysctls and platform behavior.

## Simple tests

`buck2 test //src/images/minimos/...` runs the bounded Docker boot smoke for
the base image and every example. The tests require Docker and GNU `timeout` on
the host. They do not require, and must not be replaced with, an unrestricted
`docker run --privileged` invocation.

### Local smoke test

```
buck2 test //src/images/minimos:minimos-boot-smoke

# Optional: load the same artifact for static inspection. Do not boot it with
# --privileged; use the boot-smoke target above so the test stays bounded.
docker load < $(buck2 build root//src/images/minimos:minimos-docker --show-full-simple-output)
```
