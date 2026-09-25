# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/images/minimos:defs.bzl", "minimos")

# The minimos base, which every image in this tree builds on. Two layers,
# a culled Wolfi systemd rootfs and a first-party overlay, plus a
# reference image made of nothing else. Packages under examples/ stack
# their own layers on top with minimos.image().

# The composition policy minimos.image() enforces on every layer above
# the base. tools/security_tests.py reads the same file, so the
# adversarial tests always check what ships.
depot.export_file(
    name = "policy.txt",
    src = "policy.txt",
    visibility = ["PUBLIC"],
)

# --------------------------------------------------------------------------
# Layer 1: systemd, dbus, logind and their .so closure, the login shells
# and mount(8) exe.dev needs, and chronyd, culled per base/keepfiles.txt
# and base/denyfiles.txt.
#
# Wolfi builds systemd with its optional libraries behind dlopen, so the
# library set below is a choice rather than a closure. It covers the
# features minimos uses: mount units, journal compression, seccomp
# sandboxing and ACLs.
# --------------------------------------------------------------------------

minimos.apk_culled_layer(
    name = "culled-layer",
    apks = [
        # rootfs skeleton and merged-usr symlinks
        "wolfi-baselayout",
        "ca-certificates-bundle",
        # loader and libc, plus the C.UTF-8 locale the boot contract exports
        "ld-linux",
        "glibc",
        "glibc-locale-posix",
        "libgcc",
        "systemd",
        "systemd-systemctl",
        "systemd-logind-service",
        "libsystemd",
        "libsystemd-shared",
        # dbus and its DT_NEEDED libraries
        "dbus",
        "dbus-libs",
        "libexpat1",
        "libaudit",
        "libcap-ng",
        # systemd's dlopen'd libraries that minimos ships, see keepfiles.txt
        "libmount",
        "libblkid",
        "libseccomp",
        "libacl1",
        "libzstd1",
        "liblz4-1",
        "libselinux",
        "libpcre2-8-0",
        "libsepol",
        # bash links terminfo, and the base keeps three entries
        "ncurses",
        "ncurses-terminfo-base",
        # the clock, disciplined from the hypervisor's PTP device
        "chrony",
        "libcap",
        # exe.dev boot contract: login shells, mount/umount, nologin
        "bash",
        "dash",
        "mount",
        "umount",
        "util-linux-login",
    ],
    denyfiles = "base/denyfiles.txt",
    keepfiles = "base/keepfiles.txt",
    # Nothing sits below the base, so the whole closure ships.
    provided_by = [],
    visibility = ["PUBLIC"],
)

# --------------------------------------------------------------------------
# Layer 2: the first-party overlay. Units and drop-ins, the baked account
# files, the two sysctl tiers, and masks for vendor units the culled
# rootfs can't or shouldn't run.
# --------------------------------------------------------------------------

# Vendor units that ship in the culled layer but need a binary the
# denylist drops, hardware the VM lacks, or behavior an appliance doesn't
# want. A masked unit shows as "masked" rather than "failed", so
# `systemctl is-system-running` can say "running".
MASKED_UNITS = [
    # Kernel filesystems. The platform kernel mounts what it needs on a
    # VM, and the docker smoke deliberately mounts none of them.
    "dev-hugepages.mount",
    "sys-kernel-debug.mount",
    "sys-kernel-tracing.mount",
    "sys-kernel-config.mount",
    "proc-sys-fs-binfmt_misc.automount",
    "proc-sys-fs-binfmt_misc.mount",
    # The build resolves .so dependencies, so there is no ldconfig.
    "ldconfig.service",
    # Nothing on an appliance asks for a passphrase.
    "systemd-ask-password-wall.path",
    "systemd-ask-password-wall.service",
    "systemd-ask-password-console.path",
    "systemd-ask-password-console.service",
    "systemd-ask-password.socket",
    # Root socket services minimos doesn't use. The management plane stays
    # journald, dbus and logind, with no credential, hostname or rfkill
    # helper listening for every local process.
    "systemd-creds.socket",
    "systemd-hostnamed.service",
    "systemd-hostnamed.socket",
    "systemd-journalctl.socket",
    "systemd-oomd.socket",
    "systemd-rfkill.socket",
    # No gettys or consoles, and agetty isn't shipped.
    "getty.target",
    "console-getty.service",
    "serial-getty@.service",
    "getty@.service",
    "container-getty@.service",
    # Partitioning, boot loader and hibernation, whose binaries are denied.
    "systemd-repart.service",
    "systemd-boot-random-seed.service",
    "systemd-hibernate-clear.service",
    # The platform provides entropy, so no seed file is saved.
    "systemd-random-seed.service",
    # The platform configures the network from the kernel command line.
    "systemd-networkd.service",
    "systemd-networkd.socket",
    "systemd-resolved.service",
    # Accounts are baked into /etc/{passwd,group,shadow} and nothing may
    # rewrite them at boot. sysusers.d is culled too, and the boot smoke
    # checks the files don't change.
    "systemd-sysusers.service",
    # Varlink sockets for binaries the denylist drops, masked so
    # sockets.target doesn't listen for them.
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
        "etc/systemd/system/local-fs.target.wants",
        "etc/systemd/system/multi-user.target.wants",
        "etc/systemd/system/sysinit.target.wants",
        "etc/systemd/system/system.slice.d",
        "etc/systemd/system/systemd-growfs-root.service.d",
        "etc/systemd/system/user-workload.slice.d",
        "etc/systemd/system/user.slice.d",
        "etc/systemd/system/user@.service.d",
        "etc/systemd/system.conf.d",
        "etc/systemd/user.conf.d",
        "etc/systemd/journald.conf.d",
        "etc/dbus-1",
        "etc/dbus-1/system.d",
        "etc/tmpfiles.d",
        "etc/sysctl.d",
        "etc/chrony",
        "run",
        "tmp:1777",
        "var",
        "var/log",
        "var/lib",
        # chronyd writes its drift file here after dropping to uid 106.
        # StateDirectory= can't own it, because systemd resets an Exec
        # directory to the unit's User=, root, on every exec.
        "var/lib/chrony:750:106:107",
        "root:700",
        "home",
        # The platform sshd logs everyone in as exedev, and exe-setup.service
        # runs there as exedev.
        "home/exedev:700:1000:1000",
        # First-party files that must stay out of the automatic search
        # paths. Each file says why.
        "usr/lib/minimos",
        # Mountpoint for the platform's injected sshd and friends.
        "exe.dev",
    ],
    # Empty rather than absent. systemd fills an empty machine-id with a
    # fresh ID at boot, so no two VMs share one. A missing file would also
    # count as systemd's "first boot" and apply preset policy to every unit.
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
        # Unused until a composition lingers an account, as examples/dev
        # does. Only the base may ship a drop-in for a base unit.
        "etc/systemd/system/user@.service.d/50-no-pam.conf": "base/units/user@.service.d/50-no-pam.conf",
        "etc/systemd/system/user@.service.d/60-minimos-delegate.conf": "base/units/user@.service.d/60-minimos-delegate.conf",
        "etc/systemd/system/dbus.service.d/50-minimos-hardening.conf": "base/units/dbus.service.d/50-minimos-hardening.conf",
        "etc/systemd/system/systemd-growfs-root.service.d/50-minimos-vm-only.conf": "base/units/systemd-growfs-root.service.d/50-minimos-vm-only.conf",
        "etc/dbus-1/system.d/50-minimos-deny.conf": "base/config/dbus-minimos-deny.conf",
        "etc/sysctl.d/00-unprivileged-ports.conf": "base/config/sysctl.d/00-unprivileged-ports.conf",
        "etc/sysctl.d/60-minimos-hardening.conf": "base/config/sysctl.d/60-minimos-hardening.conf",
        # Both shadow the vendor file of the same name in /usr/lib/tmpfiles.d.
        "etc/tmpfiles.d/systemd.conf": "base/config/tmpfiles-systemd.conf",
        "etc/tmpfiles.d/var.conf": "base/config/tmpfiles-var.conf",
        "usr/lib/minimos/chrony-ptp.conf": "base/config/chrony-ptp.conf",
        "usr/lib/minimos/sysctl-vm.conf": "base/config/sysctl-vm.conf",
        "usr/lib/minimos/exe-setup-clean.conf": "base/config/exe-setup-clean.conf",
        "usr/lib/minimos/docker-boot-wrapper": "base/config/docker-boot-wrapper:755",
        "usr/lib/minimos/login-shell": "base/config/login-shell:755",
        "etc/chrony/chrony.conf": "base/config/chrony.conf",
        "etc/passwd": "base/config/passwd",
        "etc/group": "base/config/group",
        "etc/shadow": "base/config/shadow:640",
        "etc/nsswitch.conf": "base/config/nsswitch.conf",
        "etc/os-release": "base/config/os-release",
        # No /etc/hostname. The platform puts each VM's name on the kernel
        # command line (ip=...:<name>:eth0:...), and a baked file would
        # give every VM the same name instead.
        "etc/hosts": "base/config/hosts",
        "etc/resolv.conf": "base/config/resolv.conf",
    },
    masks = MASKED_UNITS,
    symlinks = {
        # /sbin/init needs nothing here, since Wolfi's systemd ships
        # usr/bin/init and baselayout points /sbin at usr/bin. Wolfi has no
        # /bin/sh, though. dash installs only /usr/bin/dash, and #!/bin/sh
        # scripts and the platform's `/bin/sh -c` bootstrap both need sh.
        "usr/bin/sh": "dash",
        # Grow / to fill its disk on every boot, so `resize` takes effect.
        # exeuntu does this with an x-systemd.growfs line in /etc/fstab.
        # minimos has no fstab, so the vendor unit is linked in directly.
        "etc/systemd/system/local-fs.target.wants/systemd-growfs-root.service": "/usr/lib/systemd/system/systemd-growfs-root.service",
    },
    # Each unit is enabled per its own [Install] section, minimos-harden
    # into sysinit.target and the other two into multi-user.target.
    units = [
        "base/units/chronyd.service",
        "base/units/exe-setup.service",
        "base/units/minimos-harden.service",
    ],
    visibility = ["PUBLIC"],
)

# The base image alone, bootable with no other layers. Its boot smoke
# tests the base.
minimos.image(
    name = "minimos",
    description = "Minimal systemd OCI image for exe.dev",
    version = "0.4.0",
    visibility = ["PUBLIC"],
)
