# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/images/minimos:defs.bzl", "minimos")

# --------------------------------------------------------------------------
# minimos: the base layer every image in this tree composes on. Two
# layers — a culled Wolfi systemd rootfs and a first-party overlay —
# plus a bootable reference image built from nothing else. Downstream
# packages (see examples/) stack their own layers on top via
# minimos.image().
# --------------------------------------------------------------------------

_WOLFI = "third-party//by-name/wo/wolfi"

# The composition policy lives in defs.bzl; tools/security_tests.py reads the
# shipped lists out of it so the adversarial tests can never drift from what
# minimos.image() actually enforces.
depot.export_file(
    name = "defs.bzl",
    src = "defs.bzl",
    visibility = ["PUBLIC"],
)

# --------------------------------------------------------------------------
# Layer 1: culled systemd rootfs, assembled from pinned Wolfi packages
# (hash-verified .apk files; no donor image, no package manager) and
# culled down per base/keepfiles.txt / base/denyfiles.txt:
#   - systemd + dbus + logind and their .so closure
#   - login shells and mount(8), which exe.dev requires (see README)
# Wolfi builds systemd with optional deps behind dlopen, so the library
# set below is a choice, not a closure: only the features minimos uses
# ship (mount units, journal compression, seccomp sandboxing, ACLs).
# --------------------------------------------------------------------------

minimos.apk_culled_layer(
    name = "culled-layer",
    apks = [
        # rootfs skeleton and merged-usr symlinks
        "{}:wolfi-baselayout.apk".format(_WOLFI),
        "{}:ca-certificates-bundle.apk".format(_WOLFI),
        # loader + libc (+ the C.UTF-8 locale the boot contract exports)
        "{}:ld-linux.apk".format(_WOLFI),
        "{}:glibc.apk".format(_WOLFI),
        "{}:glibc-locale-posix.apk".format(_WOLFI),
        "{}:libgcc.apk".format(_WOLFI),
        # systemd proper
        "{}:systemd.apk".format(_WOLFI),
        "{}:systemd-systemctl.apk".format(_WOLFI),
        "{}:systemd-logind-service.apk".format(_WOLFI),
        "{}:libsystemd.apk".format(_WOLFI),
        "{}:libsystemd-shared.apk".format(_WOLFI),
        # dbus and its DT_NEEDED libraries
        "{}:dbus.apk".format(_WOLFI),
        "{}:dbus-libs.apk".format(_WOLFI),
        "{}:libexpat1.apk".format(_WOLFI),
        "{}:libaudit.apk".format(_WOLFI),
        "{}:libcap-ng.apk".format(_WOLFI),
        # dlopen'd systemd deps we choose to ship (see keepfiles.txt)
        "{}:libmount.apk".format(_WOLFI),
        "{}:libblkid.apk".format(_WOLFI),
        "{}:libseccomp.apk".format(_WOLFI),
        "{}:libacl1.apk".format(_WOLFI),
        "{}:libzstd1.apk".format(_WOLFI),
        "{}:liblz4-1.apk".format(_WOLFI),
        "{}:libselinux.apk".format(_WOLFI),
        "{}:libpcre2-8-0.apk".format(_WOLFI),
        "{}:libsepol.apk".format(_WOLFI),
        # bash links terminfo; the base ships a minimal terminfo set
        "{}:ncurses.apk".format(_WOLFI),
        "{}:ncurses-terminfo-base.apk".format(_WOLFI),
        # exe.dev boot contract: login shells + mount/umount + nologin
        "{}:bash.apk".format(_WOLFI),
        "{}:dash.apk".format(_WOLFI),
        "{}:mount.apk".format(_WOLFI),
        "{}:umount.apk".format(_WOLFI),
        "{}:util-linux-login.apk".format(_WOLFI),
    ],
    denyfiles = "base/denyfiles.txt",
    keepfiles = "base/keepfiles.txt",
    visibility = ["PUBLIC"],
)

# --------------------------------------------------------------------------
# Layer 2: minimos first-party overlay
#   - our systemd units and drop-ins
#   - /etc/{passwd,group,shadow,nsswitch.conf,os-release,hosts}
#   - hardening sysctls (netns-safe in /etc/sysctl.d, host-global in
#     /usr/lib/minimos applied only on real VMs)
#   - masks for units the culled rootfs can't (or must not) satisfy
# --------------------------------------------------------------------------

# Units that ship in the culled layer but reference binaries the
# denylist drops, hardware the VM doesn't have, or behaviour an
# appliance doesn't want. Masked so systemctl reports them as "masked"
# instead of "failed" and `is-system-running` returns "running".
MASKED_UNITS = [
    # Kernel filesystems — the host kernel mounts these for us on a real VM,
    # and in Docker we deliberately don't.
    "dev-hugepages.mount",
    "sys-kernel-debug.mount",
    "sys-kernel-tracing.mount",
    "sys-kernel-config.mount",
    "proc-sys-fs-binfmt_misc.automount",
    "proc-sys-fs-binfmt_misc.mount",
    # ldconfig binary isn't in the image (we resolve .so deps at build time).
    "ldconfig.service",
    # ask-password agents: nothing in an appliance asks for passphrases.
    "systemd-ask-password-wall.path",
    "systemd-ask-password-wall.service",
    "systemd-ask-password-console.path",
    "systemd-ask-password-console.service",
    "systemd-ask-password.socket",
    # Optional root socket services which minimos does not use. Keep the
    # management plane to journal/dbus/logind instead of exposing credential,
    # hostname, and rfkill helpers to every local process.
    "systemd-creds.socket",
    "systemd-hostnamed.service",
    "systemd-hostnamed.socket",
    "systemd-journalctl.socket",
    "systemd-oomd.socket",
    "systemd-rfkill.socket",
    # No gettys or consoles in an appliance image (agetty isn't shipped).
    "getty.target",
    "console-getty.service",
    "serial-getty@.service",
    "getty@.service",
    "container-getty@.service",
    # Partitioning / boot-loader / hibernation surfaces whose binaries
    # the denylist drops.
    "systemd-repart.service",
    "systemd-boot-random-seed.service",
    "systemd-hibernate-clear.service",
    # random-seed persistence: the platform provides entropy.
    "systemd-random-seed.service",
    # Networking daemons we don't run (the platform configures the VM).
    "systemd-networkd.service",
    "systemd-networkd.socket",
    "systemd-resolved.service",
    # Accounts are baked into the overlay's /etc/{passwd,group,shadow};
    # nothing may rewrite them at boot (sysusers.d is culled too, and
    # the boot smoke asserts the files don't drift).
    "systemd-sysusers.service",
    # Socket-activated varlink services whose backing binaries the
    # denylist drops; masked so sockets.target doesn't listen for them.
    "systemd-bootctl.socket",
    "systemd-coredump.socket",
    "systemd-factory-reset.socket",
    "systemd-mute-console.socket",
    "systemd-repart.socket",
    "systemd-storage-block.socket",
    "systemd-storage-fs.socket",
    "systemd-sysext.socket",
]

minimos.overlay(
    name = "overlay-layer",
    dirs = [
        "etc",
        "etc/systemd",
        "etc/systemd/system",
        "etc/systemd/system/dbus.service.d",
        "etc/systemd/system/init.scope.d",
        "etc/systemd/system/multi-user.target.wants",
        "etc/systemd/system/sysinit.target.wants",
        "etc/systemd/system/system.slice.d",
        "etc/systemd/system/user.slice.d",
        "etc/systemd/system.conf.d",
        "etc/systemd/journald.conf.d",
        "etc/dbus-1",
        "etc/dbus-1/system.d",
        "etc/tmpfiles.d",
        "etc/sysctl.d",
        "run",
        "tmp:1777",
        "var",
        "var/log",
        "root:700",
        "home",
        # First-party config that isn't /etc: the VM-only sysctls and the
        # exe-setup cleanup list (see those files for why).
        "usr/lib/minimos",
        # Mountpoint for the platform's injected tooling (sshd et al).
        "exe.dev",
        # Writable by uid 1000: the platform sshd logs the exe.dev user in
        # as exedev, and exe-setup.service runs with User=exedev and
        # WorkingDirectory=/home/exedev.
        "home/exedev:700:1000:1000",
    ],
    # Empty machine-id; systemd writes one on first boot.
    empty_files = [
        "etc/machine-id:444",
    ],
    files = {
        "etc/systemd/system.conf.d/minimos-overrides.conf": "base/units/system.conf.d/minimos-overrides.conf",
        "etc/systemd/user.conf.d/minimos-overrides.conf": "base/units/user.conf.d/minimos-overrides.conf",
        "etc/systemd/journald.conf.d/persistent.conf": "base/units/journald.conf.d/persistent.conf",
        "etc/systemd/system/init.scope.d/50-minimos-qos.conf": "base/units/init.scope.d/50-minimos-qos.conf",
        "etc/systemd/system/system.slice.d/50-minimos-qos.conf": "base/units/system.slice.d/50-minimos-qos.conf",
        "etc/systemd/system/user.slice.d/50-minimos-qos.conf": "base/units/user.slice.d/50-minimos-qos.conf",
        "etc/systemd/system/user-workload.slice": "base/units/user-workload.slice",
        "etc/systemd/system/user-workload.slice.d/90-minimos-qos.conf": "base/units/user-workload.slice.d/90-minimos-qos.conf",
        "etc/systemd/system/minimos-harden.service": "base/units/minimos-harden.service",
        "etc/systemd/system/dbus.service.d/50-minimos-hardening.conf": "base/units/dbus.service.d/50-minimos-hardening.conf",
        "etc/dbus-1/system.d/50-minimos-deny.conf": "base/config/dbus-minimos-deny.conf",
        "etc/sysctl.d/00-unprivileged-ports.conf": "base/config/sysctl.d/00-unprivileged-ports.conf",
        "etc/sysctl.d/60-minimos-hardening.conf": "base/config/sysctl.d/60-minimos-hardening.conf",
        # Both shadow the vendor file of the same name in /usr/lib/tmpfiles.d.
        "etc/tmpfiles.d/systemd.conf": "base/config/tmpfiles-systemd.conf",
        "etc/tmpfiles.d/var.conf": "base/config/tmpfiles-var.conf",
        "usr/lib/minimos/sysctl-vm.conf": "base/config/sysctl-vm.conf",
        "usr/lib/minimos/exe-setup-clean.conf": "base/config/exe-setup-clean.conf",
        "usr/lib/minimos/docker-boot-wrapper": "base/config/docker-boot-wrapper:755",
        "usr/lib/minimos/login-shell": "base/config/login-shell:755",
        "etc/passwd": "base/config/passwd",
        "etc/group": "base/config/group",
        "etc/shadow": "base/config/shadow:640",
        "etc/nsswitch.conf": "base/config/nsswitch.conf",
        "etc/os-release": "base/config/os-release",
        # No /etc/hostname: the platform passes the per-VM name on the
        # kernel cmdline (ip=...:<name>:eth0:...), and a baked file
        # would override it with the same name on every VM.
        "etc/hosts": "base/config/hosts",
        "etc/resolv.conf": "base/config/resolv.conf",
    },
    masks = MASKED_UNITS,
    # /sbin/init needs no overlay entry: Wolfi's systemd package ships
    # usr/bin/init -> ../lib/systemd/systemd and baselayout points
    # /sbin at usr/bin. Wolfi has no /bin/sh at all, though — dash only
    # installs /usr/bin/dash — so the sh every #!/bin/sh script and the
    # platform's `/bin/sh -c` bootstrap need is ours to provide.
    symlinks = {
        "etc/systemd/system/sysinit.target.wants/minimos-harden.service": "/etc/systemd/system/minimos-harden.service",
        "usr/bin/sh": "dash",
    },
    units = [
        "base/units/exe-setup.service",
    ],
    visibility = ["PUBLIC"],
)

# --------------------------------------------------------------------------
# The base image itself: nothing but the two base layers. Bootable on
# its own — this is what the boot-smoke test exercises.
# --------------------------------------------------------------------------

minimos.image(
    name = "minimos",
    description = "Minimal systemd OCI image for exe.dev",
    version = "0.4.0",
    visibility = ["PUBLIC"],
)
