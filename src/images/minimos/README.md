# minimos

This is an attempt to create a Bottlerocket-like, appliance-style OCI image
for exe.dev virtual machines. The goal is the smallest reasonable image that
will boot and host working services. There is no distro userspace, coreutils,
SSH daemon (the platform provides a self-contained `/exe.dev/bin/sshd`), or
package manager. The base is systemd, its shared-library closure, and the
minimum `/etc` it needs, plus `bash`, `dash`, and `nologin` for the platform
bootstrap and account-shell contract described below.

Everything is assembled from pinned [Wolfi](https://wolfi.dev) packages —
Chainguard's glibc-based rolling "undistro" built for exactly this kind
of container-shaped, security-patched minimalism. The build downloads
hash-verified `.apk` files (see `third-party//by-name/wo/wolfi`),
extracts them with ~100 lines of stdlib Python, and culls the result;
there is no donor image, no `apk` at build or run time, and no unpinned
`latest` anywhere. Refreshing the OS is a version+hash bump in one BUILD
file, gated by the boot-smoke tests.

minimos is structured as a **base layer**: this package builds the two
layers every image starts from, and downstream packages compose services
on top of them through the macros in `defs.bzl`.

## Layout

```
src/images/minimos/
  BUILD                    — base layers + the :minimos reference image
  defs.bzl                 — the composition API: minimos.image() & friends
  base/                    — everything that goes INTO the base image
    keepfiles.txt          —   allowlist culling the Wolfi rootfs to systemd
    denyfiles.txt          —   paths dropped from the culled rootfs
    config/                —   /etc files (passwd, group, sysctl.d, …)
    units/                 —   systemd units and drop-ins
  tools/                   — generic machinery (apk, cull, overlay, image, test)
  examples/                — worked compositions; copy one to start yours
    memcached/             —   the minimum: one binary, one unit
    valkey/                —   config file + state dir + CLI for verification
    nginx/                 —   static content, multiple HTTP ports
    dev/                   —   interactive userland + per-user systemd manager
    codex/                 —   dev machine + the Codex CLI coding agent
```

## Composing an image on minimos

`defs.bzl` exports a `minimos` struct; one load gives a downstream
package everything it needs:

```bzl
load("@root//src/images/minimos:defs.bzl", "minimos")

# 1. Cull the service binary + its .so closure out of pinned Wolfi
#    packages (pin them in third-party//by-name/wo/wolfi first), driven
#    by keepfiles.txt/denyfiles.txt in your package. Include glibc so
#    the closure resolves; denylist it so the base's copy wins.
minimos.apk_culled_layer(
    name = "app-culled-layer",
    apks = ["third-party//by-name/wo/wolfi:app.apk", ...],
)

# 2. Declare your config/unit/content layer — no tar-writing script needed.
minimos.overlay(
    name = "app-overlay-layer",
    dirs = ["etc", "var", "var/lib/app"],
    files = {"etc/app.conf": "app.conf"},
    units = ["app.service"],          # installed + enabled in multi-user.target
)

# 3. Assemble: base layers first, yours on top. Emits <name>,
#    <name>-docker, and <name>-boot-smoke.
minimos.image(
    name = "my-app",
    description = "minimos + my app",
    layers = [":app-culled-layer", ":app-overlay-layer"],
    ports = ["80/tcp"],
    boot_smoke_units = ["app.service"],
)
```

For services with no Wolfi package, `minimos.pull` + `minimos.culled_layer`
cull an arbitrary OCI donor image instead — see the ABI rules in the
`defs.bzl` docstring before reaching for that.

`minimos.image` always stacks `:culled-layer` + `:overlay-layer` from this
package underneath and bakes in the exe.dev boot contract: systemd as Cmd
(`/sbin/init --log-target=syslog --show-status=true --log-color=false`),
`PATH`/`LANG`, `User=root`, and the `exe.dev/login-user=exedev` label.

It also enforces a composition policy on everything stacked above those two
layers: your layers may add paths under the composable prefixes, but may not
redefine anything the base established or write into a sealed directory. If a
build fails with `writes /… , which is not under a composable path` or
`replaces /…, which a lower layer established`, that is this policy — see
`_COMPOSABLE_PATHS` / `_SEALED_PATHS` in `defs.bzl` and the reasoning in the
hardening section below. The usual cause of the second message is a culled
layer re-shipping a library the base already carries; denylist it, the way
`examples/nginx` does for libpcre2.

The worked versions of this pattern live in [examples/](examples/) with
their own README.

## Security & hardening

The threat model is "trusted workloads on a single-owner VM": the base
is hardened against a compromised *service* and against kernel-surface
abuse, not against the VM's own administrative user or mutually untrusted
tenants. Bottlerocket gets its guarantees
from a dm-verity rootfs, an always-enforcing SELinux policy, and a
signed kernel — none of which exist on a platform-provided kernel with a
mutable ext4 root. What transfers is the rest of its posture, and the
two levers Bottlerocket itself barely uses (its units carry no sandbox
directives at all): runtime sysctls and per-unit systemd sandboxing.

What the base enforces:

- **Nothing is setuid/setgid and nothing is world-writable** (sans
  sticky dirs). `cull.py` strips the bits Wolfi ships on
  `mount`/`umount`, and every image's boot smoke fails if any layer
  regresses.
- **A composition layer writes where it is allowed to, not everywhere it is
  not forbidden.** Two rules need no list: a layer stacked on the base can
  never redefine a path a lower layer established — every one of the base's
  ~670 paths, from PID 1 to the account files to each vendor unit — and can
  never write a type-wide systemd drop-in (`service.d`, `user-.slice.d`) that
  would reconfigure units it does not own. Beyond that, a *new* path must fall
  under one of ten composable prefixes (`etc`, `usr/bin`, `usr/lib`, `var`,
  `home`, …), minus sealed carve-outs inside them: identity files, the
  `ld.so` hooks, every sysctl/tmpfiles/sysusers/modules search directory,
  systemd's manager config and unit paths that outrank `/etc/systemd/system`,
  the generator directories, bus policy, and the trust roots. The default is
  refusal, so a search path nobody anticipated — a future systemd unit
  directory, a new loader hook — is denied because it was never opened rather
  than allowed because it was never denied. `scratch_image.py` enforces this
  at build time, independently of the boot smoke, and
  `tools/security_tests.py` reads the shipped lists straight out of
  `defs.bzl` so the adversarial cases cannot drift from what ships.
- **Accounts are baked.** `/etc/{passwd,group,shadow}` come from
  `base/config/` only; `sysusers.d` is culled and `systemd-sysusers`
  masked, and the boot smoke asserts the files are byte-identical after
  boot. All accounts are locked (`!*`); there is no PAM, no login(1),
  no sudo.
- **No login path to uid 0.** The local `root` account is locked and uses
  `/usr/sbin/nologin`; `exedev` is also password-locked and is authenticated
  by the platform. exe.dev maps external SSH names — including a request for
  `root` — to the image's `exe.dev/login-user` (`exedev`, uid 1000), so
  `ssh root@...` does not produce a root shell. `exedev` uses
  `/usr/lib/minimos/login-shell`, which sets `umask 077`, disables core dumps,
  and then starts Bash. The image ships no sudo, su, polkit, or setuid helper;
  uid 0 remains for PID 1 and explicitly root system services. Administration
  means rebuilding the image. `exedev` is in `systemd-journal` so the VM's
  single owner can still use `journalctl` and `systemctl status` over SSH —
  which takes more than the group membership, because journald creates
  `/var/log/journal/<machine-id>` as 0755 root:root and does not inherit the
  parent's setgid group. `/etc/tmpfiles.d/systemd.conf` corrects the directory
  and the first journal file; the boot smoke asserts the group can actually
  read the journal, since an appliance whose owner cannot read logs has no
  other way to investigate anything.
- **Two-tier sysctls.** Everything reachable from the automatic sysctl search
  path is network-namespace-scoped, so this rootfs cannot change a host's
  global `fs.*`, `dev.*`, `user.*`, `kernel.*`, or `vm.*` state when it boots
  under Docker. That holds for `/usr/lib/sysctl.d` as much as `/etc/sysctl.d`:
  systemd's own `50-default.conf` and `50-pid-max.conf` mix host-global
  `kernel.pid_max`, `kernel.sysrq` and `fs.protected_*` keys into that path,
  so both are denylisted alongside `50-coredump.conf`, and their
  namespace-scoped half (rp_filter, source-route rejection,
  promote-secondaries) is restated in `60-minimos-hardening.conf`. That tier
  also rejects redirects/router advertisements, enables syncookies, and
  restores `net.ipv4.ip_unprivileged_port_start=1024`; a service that really
  needs a low port must receive the narrow capability in its own unit.
  The host-global keys live outside the search path at
  `/usr/lib/minimos/sysctl-vm.conf`, applied during `sysinit.target` by
  `minimos-harden.service`. They latch module loading off, restrict dmesg/kptr,
  unprivileged BPF and io_uring, apply KSPP filesystem/tty settings, disable
  suid coredumps and sysrq, set panic-on-oops/reboot behavior, and put finite
  ceilings on inotify, mmap, and all supported per-user namespace counts. The
  VM-only file is never applied by the Docker smoke harness.

  That unit is gated `ConditionVirtualization=!container` rather than `=vm`, so
  the failure direction is right: an unrecognized hypervisor still gets
  hardened and a container is still refused, where `=vm` would have let a VM
  whose virtualization systemd could not identify skip the whole tier in
  silence. Because `systemd-sysctl` logs and continues when a key will not
  take, the unit reads `kernel.modules_disabled` back afterwards and fails if
  it did not latch. Keys absent from the platform kernel — `kernel.sysrq`,
  `kernel.yama.ptrace_scope` and friends — carry the `-` prefix, without which
  they would log a warning on every boot.
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
- **Nothing outside the image provisions the image.** `provision.conf` (which
  writes `/etc/hosts` and `/root/.ssh/authorized_keys` from SMBIOS/fw_cfg/
  cmdline credentials), `static-nodes-permissions.conf` (which chmods
  `/dev/{fuse,net/tun,kvm,vhost-*}` to 0666), and the `systemd-run` and
  `systemd-debug` generators (which turn `systemd.run=` and
  `systemd.extra-unit.*` into root-executed units ahead of everything in
  `/etc/systemd/system`) are all denylisted. Configuration changes are image
  rebuilds, for the same reason `sysusers.d` is culled.
- **No coredump machinery**: `systemd-coredump` is culled, its
  `core_pattern` sysctl denied, `DumpCore=no` + `DefaultLimitCORE=0`
  set globally; the persistent journal is capped at 64M.
- **Deliberate divergences from Bottlerocket.** User namespaces remain
  available, with finite VM-only object-count ceilings, so unprivileged
  bubblewrap works and a future rootless-runtime composition remains possible.
  There is no global `NoNewPrivileges=` because a future container runtime may
  need controlled privilege transitions; individual services set it through
  their sandbox policy.

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
  `assemble_and_cull.sh`, or unpacked from an OCI donor via
  `unpack_and_cull.sh` + umoci) and emits a tarball containing only the
  allowlisted paths plus the recursive `.so` closure of every kept ELF
  binary. It fails on sonames it cannot resolve — Wolfi builds
  systemd's optional deps behind dlopen, so keepfiles.txt names the
  dlopen'd libraries we choose to ship and the check catches their missing
  DT_NEEDED tails. It never guesses that a child named `rootfs` is a bundle
  root, charges repeated hardlink paths against the expanded-content budget,
  and atomically publishes only a complete bounded tar.
- `mkoverlay.py` builds a deterministic overlay tar from CLI declarations
  (dirs, files, symlinks, systemd units, masks; files and dirs take
  optional mode/uid/gid) — this is what makes `minimos.overlay()`
  possible without per-image Python. Inputs are descriptor-snapshotted and
  bounded; a failed build preserves any prior output.
- `extract_one.py` streams a single member out of a tarball — how a
  GitHub-release binary (examples/codex) becomes an overlay input
  without trusting the archive's own metadata.
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
  still needs capabilities such as `SYS_ADMIN` inside its container. Run
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

### `exe.dev` virtual machine

```
# exe.dev end-to-end (via ttl.sh — anonymous, TTL-based)
docker load < $(buck2 build root//src/images/minimos:minimos-docker --show-full-simple-output)
docker tag minimos:latest ttl.sh/$USER-minimos:1h
docker push ttl.sh/$USER-minimos:1h
ssh exe.dev new --image=ttl.sh/$USER-minimos:1h --name minimos-test
# verify, then:
ssh exe.dev rm minimos-test
```

The same loop works for any example — e.g. the nginx one:

```
docker load < $(buck2 build //src/images/minimos/examples/nginx:minimos-nginx-docker --show-full-simple-output)
docker tag minimos-nginx:latest ttl.sh/$USER-minimos-nginx:1h
docker push ttl.sh/$USER-minimos-nginx:1h
ssh exe.dev new --image=ttl.sh/$USER-minimos-nginx:1h --name minimos-nginx
# visit https://minimos-nginx.<your-domain> — index.html renders
```

## exe.dev integration notes

Hard-won facts about what the platform expects from a custom image:

- **exe.dev gates HTTP proxy readiness on an SSH login probe.** After boot,
  the platform repeatedly tries `root` and the user named by the
  `exe.dev/login-user` OCI label until a login succeeds; until then the HTTPS
  proxy answers `503` no matter what is listening inside. The platform maps
  external SSH names to that configured login user, so even `ssh root@...`
  becomes uid 1000 rather than uid 0. The local `root` account remains locked
  with `/usr/sbin/nologin`; `exedev` uses the minimos wrapper, which ultimately
  runs Bash. The platform sshd `stat()`s account shell paths and refuses an
  account whose path is missing, so the image must ship the wrapper, Bash,
  Dash/`sh`, and `nologin` even though root is not interactive.
- **The platform's sshd is self-contained.** exe-init injects
  `/exe.dev/bin/sshd` (musl-linked against `/exe.dev/lib/ld-musl.so.1`,
  with its own host keys, authorized_keys, and config under
  `/exe.dev/etc/ssh/`) and starts it before exec'ing the image's Cmd as
  PID 1. The image needs no OpenSSH, PAM, or crypto libraries for it.
- **Ship `mount(8)`.** systemd `.mount` units (`dev-mqueue.mount`, …)
  shell out to `/usr/bin/mount`; without it the boot ends `degraded` in
  an exe.dev VM. Docker hides this by premounting `/dev/mqueue`.
- **Ship the C.UTF-8 locale.** The boot contract exports `LANG=C.UTF-8`
  and systemd forwards it to every unit; without the locale data
  (`/usr/lib/locale/C.utf8`, Wolfi's `glibc-locale-posix` package)
  `setlocale()` fails, which some daemons (valkey) treat as fatal.
- **Bake `/etc/resolv.conf`.** The VM's interface comes up from the
  kernel `ip=` cmdline parameter, which carries no DNS servers, and
  nothing on the platform writes a resolv.conf into the image — without
  one, glibc queries localhost and all resolution fails. The base bakes
  `nameserver 1.1.1.1` (what the stock image uses). Platform-internal
  names like `chatgpt.int.exe.xyz` resolve through public DNS (to a
  link-local metadata address), so no special resolver is needed.
- **ttl.sh tags are cached by the platform.** Pushing a changed image
  under the same ttl.sh tag can boot the stale bytes on the next
  `ssh exe.dev new`; use a fresh tag per push.
- **Boot diagnostics:** `ssh exe.dev vm-logs <vm>` shows the VM's console
  (systemd `--show-status` output and platform sshd stderr land there) —
  it works even when you can't SSH in. That stream is a log dump, not a
  terminal, and keeping it plain takes more than `--log-color=false`
  since systemd 256: PID 1 also probes the terminal size and emits OSC
  context sequences unless the terminal is dumb, so `minimos.image`
  bakes `TERM=dumb` and `SYSTEMD_COLORS=0` into the image env (SSH
  sessions are unaffected — the platform sshd sets its own TERM). Plain
  `ssh <vm>.exe.xyz` enters through the exedev wrapper: appliance images get a
  core-disabled Bash for triage, while dev/Codex images fail closed unless the
  wrapper can place Bash in a bounded delegated user scope. Appliance images
  have no coreutils, but Bash builtins and `systemctl`/`journalctl` are enough
  for triage.
