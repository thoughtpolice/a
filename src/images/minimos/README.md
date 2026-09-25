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
- `makes /... a symlink, which would move /...`: the link would point a
  sealed prefix, a PATH directory or a unit directory somewhere else.
  Ship a real directory there instead.
- `no layer declares its parent directory`: add the directory to `dirs`.

## Running on exe.dev

Every image has a `-push` target that builds it, pushes it with the
pinned skopeo, and prints it by digest. Boot the VM from that digest,
which exe.dev can't serve stale:

```
IMAGE=$(buck2 run //src/images/minimos:minimos-push -- ttl.sh/$USER-minimos:1h)
ssh exe.dev new --image=$IMAGE --name=minimos-test
ssh exe.dev vm-logs minimos-test   # the console, even when SSH fails
ssh exe.dev rm minimos-test
```

ttl.sh needs no account and deletes an image once its tag's time runs
out, a day at most. Pushing to the same repository again skips the
layers it already has. For a registry that needs credentials, log in
once with `buck2 run depot-toolchains//oci:skopeo -- login <registry>`,
and give `ssh exe.dev new` the same credentials with `--registry-auth`.

What the platform expects from a custom image:

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
  tag. A VM created soon after a push can boot the old image, so boot
  from the digest the push target prints.
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
  modules directory, credential stores, systemd's configuration and
  higher-priority unit paths, generators, bus policy and trust roots.
  Anything the policy doesn't open is refused, so a search path nobody
  thought of stays closed. Paths resolve through symlinks the way the
  kernel resolves them, and a layer can't turn a sealed prefix, a PATH
  directory or anything above one into a symlink, since
  `/usr/local -> /opt/x` would move all of `/usr/local/lib` at once.
  `scratch_image.py` enforces this at build time, and
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
- **Control plane first.** PID 1 and the platform SSH listener run in
  `init.scope`, and system services in `system.slice`. Both get CPU and
  I/O weight 1000, a 10% memory reserve, and task caps of 512 and 2048.
  `user.slice` gets weight 100, `MemoryHigh=70%`, `MemoryMax=80%`, no
  swap, 3072 tasks, and `io.max` ceilings on the root disk of 500 MB/s
  read, 250 MB/s write, 50K read IOPS and 25K write IOPS. exe.dev's
  virtio disk has no `io.weight`, so those ceilings are what actually
  limits disk I/O. `user-workload.slice` sits inside `user.slice` with
  65%/70% memory and 2048 tasks, for services that opt in, as
  `exe-setup.service` and the example services do.
- **The base's own services are sandboxed.** journald and logind carry
  upstream hardening. Wolfi's `dbus.service` carries none, and every
  local uid can reach it, so a base drop-in gives it the same sandbox the
  examples use, bounded to `CAP_AUDIT_WRITE` and `AF_UNIX`.
- **The bus refuses unit management outright.** systemd's vendor bus
  policy lets any uid send `StartUnit`, `MaskUnitFiles` and the like to
  PID 1 and leaves the decision to polkit. With no polkit, only systemd's
  fallback refuses them. `/etc/dbus-1/system.d/50-minimos-deny.conf`
  denies the manager interfaces on the bus as well, and allows back the
  read-only calls `systemctl status`, `systemctl list-unit-files` and
  `journalctl` need, plus the process moves a user manager asks PID 1
  for.
- **An account exists only if something uses it.** The baked files hold
  root, three Wolfi skeleton accounts, `systemd-journal`, `messagebus`,
  `chrony`, `exedev` and `nobody`. Vendor files that name an account the
  image lacks are denied, and the boot smoke fails on any that slip
  through, since a missing account shows up as a boot warning.
- **Nothing outside the image configures it.** systemd's
  `provision.conf` would write `/etc/hosts` and root's authorized_keys
  from credentials, `static-nodes-permissions.conf` would make
  `/dev/{fuse,net/tun,kvm,vhost-*}` world-writable, and the
  `systemd-run` and `systemd-debug` generators would turn kernel
  command-line options into root units ahead of `/etc/systemd/system`.
  All four are denied. Credentials are the other way in. PID 1 collects
  them from the kernel command line, SMBIOS and fw_cfg, and
  `ImportCredential=` also reads `/etc/credstore` and its siblings, so a
  `tmpfiles.extra` or `sysctl.extra` would run as root beside the
  image's sealed config. The base resets `ImportCredential=` on every
  vendor unit that runs here and imports credentials, the policy seals
  the credential stores, and the boot smoke fails if any loaded service
  still imports one.
- **The clock doesn't come from the network.** chrony reads `/dev/ptp0`
  and nothing else, with `PrivateNetwork=yes` on the unit. Wolfi builds
  chrony without NTS, so network time would be unauthenticated UDP.
  chronyd starts as root only because it checks for uid 0, drops to the
  `chrony` account itself, and keeps only `CAP_SYS_TIME`. Under docker
  the unit is skipped, since a container shares the host's clock.
- **No core dumps.** `systemd-coredump` is culled, its `core_pattern` is
  denied, and `DumpCore=no` and `DefaultLimitCORE=0` are set globally.
- **No watchdog.** exe.dev VMs have no `/dev/watchdog`, and neither
  containerd nor chronyd speaks systemd's watchdog protocol, so
  `WatchdogSec=` would kill healthy daemons. `kernel.panic_on_oops=1`,
  `kernel.panic=10` and per-unit `Restart=` cover the same ground.

Where minimos departs from Bottlerocket on purpose: user namespaces stay
available, with finite VM-only limits, so unprivileged bubblewrap works
and rootless runtimes stay possible. There's no global
`NoNewPrivileges=`, since a container runtime may need privilege
transitions. Each service sets it in its own sandbox.

To harden a new service, start from `examples/memcached/memcached.service`.
It uses `DynamicUser=`, which implies `NoNewPrivileges=`,
`ProtectSystem=strict`, `PrivateTmp=`, `RemoveIPC=` and
`RestrictSUIDSGID=`, plus `StateDirectory=` and friends instead of
hand-made `/var` directories, an empty `CapabilityBoundingSet=`, the
`Protect*` and `Restrict*` settings, `SystemCallFilter=@system-service`,
and, for loopback services, `IPAddressDeny=any` with
`IPAddressAllow=localhost`. Loosen only what the service needs, such as
`MemoryDenyWriteExecute=` for a JIT.

The dev, Codex and container-host images change some of this, and
`examples/README.md` covers how and why.

## Tools

The macros in `defs.bzl` are the only way in.

- `mkapkroot.py` extracts apk v2 packages, which are three concatenated
  gzip tar streams, into a rootfs directory. It skips the control
  entries and runs no scripts.
- `cull.py` keeps the paths a keep list names plus the `.so` closure of
  every kept ELF file, minus a deny list, and writes a tar. The closure
  resolves against the layers below first, so a composition never copies
  a library the base ships. An unresolved soname, or a keep entry that
  matches nothing, fails the build. Wolfi builds systemd's optional
  libraries behind dlopen, so the base keep list names the ones minimos
  uses.
- `mkoverlay.py` builds an overlay tar from command-line declarations,
  with every mode and owner explicit and every timestamp zero. It
  enables units the way `systemctl enable` would, from their `[Install]`
  sections.
- `scratch_image.py` assembles an OCI layout from layer tars alone, since
  `oci_image` always keeps a base image's layers. It validates the
  layout, every digest and every layer against the composition policy
  before publishing it.
- `boot_smoke.sh` runs each image's `<name>-boot-smoke` test. The header
  of the script lists what it checks.

## Testing

`buck2 test //src/images/minimos/...` runs the security tests and a
docker boot smoke for the base and every example. It needs docker and
GNU `timeout` on the host.

The boot smoke validates the image and scans its layers before docker
loads anything. It then boots systemd with a private cgroup namespace,
no network, bounded memory, CPU, PIDs, logs and tmpfs,
`no-new-privileges` and an explicit capability set, not `--privileged`.
It requires a `running` system, no failed units, and a boot journal with
no warnings beyond four known lines, which the script explains.

systemd still needs `SYS_ADMIN` in that container, and it runs without
docker's AppArmor profile, whose mount rules stop PID 1 from starting.
So it's a test for trusted build output, not a sandbox for hostile
images.

Some things can only be checked on a VM, and the docker smoke only
checks that they're wired up:

- the VM-only sysctls, including `kernel.modules_disabled=1`
- `user.slice`'s `io.max`, since docker's root has no block device
- chrony syncing from `/dev/ptp0`
- the root filesystem growing after `new --disk` or `resize`
- bubblewrap sandboxes on the dev images, which docker's seccomp blocks
- gVisor containers on the container host

A real VM's journal also has kernel messages the image can't affect,
about the TSC, CPU mitigations and missing KVM features. "No warnings"
means none the image is responsible for.
