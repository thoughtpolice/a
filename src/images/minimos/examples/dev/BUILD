# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/images/minimos:defs.bzl", "minimos")

# --------------------------------------------------------------------------
# minimos-dev: an interactive machine instead of a sealed appliance —
# coreutils and friends for day-to-day SSH use, and a running per-user
# systemd manager so buck2, coding agents, and `systemd-run --user`
# get cgroup delegation. The layers are PUBLIC on purpose: heavier
# compositions (examples/codex) stack on them.
#
# The user manager works like this: exedev "lingers" (the baked
# /var/lib/systemd/linger/exedev), so logind starts user@1000.service
# at boot without any session; user@ BindsTo user-runtime-dir@, whose
# binary the base denylist drops — a culled layer adds it (and
# loginctl) back; and a drop-in resets the PAMName= that our PAM-less
# rootfs could never satisfy.
# --------------------------------------------------------------------------

_WOLFI = "third-party//by-name/wo/wolfi"

# systemd-user-runtime-dir + loginctl, culled out of the same pinned
# systemd packages the base uses; the base's libraries satisfy the .so
# closure, so this layer is exactly two binaries.
minimos.apk_culled_layer(
    name = "user-manager-culled-layer",
    apks = [
        "{}:systemd.apk".format(_WOLFI),
        "{}:systemd-systemctl.apk".format(_WOLFI),
        "{}:systemd-logind-service.apk".format(_WOLFI),
        "{}:libsystemd.apk".format(_WOLFI),
        "{}:libsystemd-shared.apk".format(_WOLFI),
        "{}:glibc.apk".format(_WOLFI),
        "{}:ld-linux.apk".format(_WOLFI),
        "{}:libgcc.apk".format(_WOLFI),
        "{}:libmount.apk".format(_WOLFI),
        "{}:libblkid.apk".format(_WOLFI),
        "{}:libseccomp.apk".format(_WOLFI),
        "{}:libacl1.apk".format(_WOLFI),
        "{}:libzstd1.apk".format(_WOLFI),
        "{}:liblz4-1.apk".format(_WOLFI),
        "{}:libselinux.apk".format(_WOLFI),
        "{}:libpcre2-8-0.apk".format(_WOLFI),
        "{}:libaudit.apk".format(_WOLFI),
        "{}:libcap-ng.apk".format(_WOLFI),
    ],
    denyfiles = "user-manager-denyfiles.txt",
    keepfiles = "user-manager-keepfiles.txt",
    visibility = ["PUBLIC"],
)

# Interactive userland: coreutils and friends, git, jq, ripgrep. The
# tail of the list is the runtime libraries they link that the base
# doesn't ship (the curl chain is most of it); glibc and the other
# base-shipped libraries ride along for closure resolution and drop
# out via the denyfile.
minimos.apk_culled_layer(
    name = "dev-tools-culled-layer",
    apks = [
        "{}:bubblewrap.apk".format(_WOLFI),
        "{}:coreutils.apk".format(_WOLFI),
        "{}:curl.apk".format(_WOLFI),
        "{}:diffutils.apk".format(_WOLFI),
        "{}:findutils.apk".format(_WOLFI),
        "{}:gawk.apk".format(_WOLFI),
        "{}:git.apk".format(_WOLFI),
        "{}:gnutar.apk".format(_WOLFI),
        "{}:grep.apk".format(_WOLFI),
        "{}:gzip.apk".format(_WOLFI),
        "{}:jq.apk".format(_WOLFI),
        "{}:less.apk".format(_WOLFI),
        "{}:patch.apk".format(_WOLFI),
        "{}:procps.apk".format(_WOLFI),
        "{}:ripgrep.apk".format(_WOLFI),
        "{}:sed.apk".format(_WOLFI),
        "{}:xz.apk".format(_WOLFI),
        # Libraries the tools link that the base image doesn't carry.
        "{}:gdbm.apk".format(_WOLFI),
        "{}:keyutils-libs.apk".format(_WOLFI),
        "{}:krb5-libs.apk".format(_WOLFI),
        "{}:cyrus-sasl-mit-libs.apk".format(_WOLFI),
        "{}:libattr1.apk".format(_WOLFI),
        "{}:libbrotlicommon1.apk".format(_WOLFI),
        "{}:libbrotlidec1.apk".format(_WOLFI),
        "{}:libcap.apk".format(_WOLFI),
        "{}:libcom_err.apk".format(_WOLFI),
        "{}:libcurl-openssl4.apk".format(_WOLFI),
        "{}:libidn2.apk".format(_WOLFI),
        "{}:libldap.apk".format(_WOLFI),
        "{}:libnghttp2-14.apk".format(_WOLFI),
        "{}:libproc-2-0.apk".format(_WOLFI),
        "{}:libpsl.apk".format(_WOLFI),
        "{}:libunistring.apk".format(_WOLFI),
        "{}:libverto.apk".format(_WOLFI),
        "{}:nghttp3.apk".format(_WOLFI),
        "{}:ngtcp2.apk".format(_WOLFI),
        "{}:oniguruma.apk".format(_WOLFI),
        "{}:sqlite-libs.apk".format(_WOLFI),
        "{}:libssl3.apk".format(_WOLFI),
        "{}:libcrypto3.apk".format(_WOLFI),
        "{}:zlib.apk".format(_WOLFI),
        # Base-shipped libraries, present only so the closure resolves.
        "{}:glibc.apk".format(_WOLFI),
        "{}:ld-linux.apk".format(_WOLFI),
        "{}:libacl1.apk".format(_WOLFI),
        "{}:libexpat1.apk".format(_WOLFI),
        "{}:libgcc.apk".format(_WOLFI),
        "{}:libpcre2-8-0.apk".format(_WOLFI),
        "{}:libselinux.apk".format(_WOLFI),
        "{}:libzstd1.apk".format(_WOLFI),
        "{}:liblz4-1.apk".format(_WOLFI),
        "{}:ncurses.apk".format(_WOLFI),
        "{}:ncurses-terminfo-base.apk".format(_WOLFI),
    ],
    denyfiles = "dev-tools-denyfiles.txt",
    keepfiles = "dev-tools-keepfiles.txt",
    visibility = ["PUBLIC"],
)

# Linger + the PAM reset + login-shell environment. Parent directories
# (/etc/systemd/system, /var) come from the base layers.
minimos.overlay(
    name = "dev-overlay-layer",
    dirs = [
        "etc/minimos",
        "etc/systemd/user",
        "etc/systemd/system/user@.service.d",
        "var/lib",
        "var/lib/systemd",
        "var/lib/systemd/linger",
    ],
    # Lingering is a zero-length marker file named after the account:
    # logind sees it at boot and starts user@1000 with no session.
    empty_files = [
        # Makes the base login wrapper fail closed unless it can hand the SSH
        # command to the bounded, delegated user manager.
        "etc/minimos/require-user-scope:444",
        "var/lib/systemd/linger/exedev",
    ],
    files = {
        "etc/profile": "profile",
        "etc/systemd/system/user@.service.d/50-no-pam.conf": "user-no-pam.conf",
        "etc/systemd/system/user@.service.d/60-minimos-delegate.conf": "user-delegate.conf",
    },
    symlinks = {
        # The broad upstream user unit tree contains socket surfaces whose
        # backing binaries the image deliberately culls.
        "etc/systemd/user/systemd-ask-password.socket": "/dev/null",
        "etc/systemd/user/systemd-journalctl.socket": "/dev/null",
        "etc/systemd/user/systemd-storage-fs.socket": "/dev/null",
    },
    visibility = ["PUBLIC"],
)

minimos.image(
    name = "minimos-dev",
    boot_smoke_dev = True,
    boot_smoke_units = ["user@1000.service"],
    boot_smoke_userland = True,
    description = "minimos + interactive dev tooling and a lingering user manager",
    layers = [
        ":user-manager-culled-layer",
        ":dev-tools-culled-layer",
        ":dev-overlay-layer",
    ],
    version = "0.1.0",
    visibility = ["PUBLIC"],
)
