# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/images/minimos:defs.bzl", "minimos")

# minimos-dev: a machine to work on rather than an appliance. It has
# coreutils and the usual tools for SSH use, and a per-user systemd
# manager so buck2, coding agents and `systemd-run --user` get cgroup
# delegation. The layers are public so examples/codex can stack on them.
#
# exedev lingers through the baked /var/lib/systemd/linger/exedev, so
# logind starts user@1000.service at boot with no session. user@ binds to
# user-runtime-dir@, whose binary the base denies, so a small culled layer
# brings it back along with loginctl. The base's own user@.service
# drop-ins handle the missing PAM and the delegation.

# systemd-user-runtime-dir and loginctl from the same systemd package the
# base uses. The base has every library they link, so the layer is two
# files.
minimos.apk_culled_layer(
    name = "user-manager-culled-layer",
    apks = [
        "systemd",
    ],
    keepfiles = "user-manager-keepfiles.txt",
    visibility = ["PUBLIC"],
)

# The interactive tools, then the libraries they link that the base
# doesn't ship. curl's dependencies are most of that list.
minimos.apk_culled_layer(
    name = "dev-tools-culled-layer",
    apks = [
        "bubblewrap",
        "coreutils",
        "curl",
        "diffutils",
        "findutils",
        "gawk",
        "git",
        "gnutar",
        "grep",
        "gzip",
        "jq",
        "less",
        "patch",
        "procps",
        "ripgrep",
        "sed",
        "xz",
        # Libraries the tools link that the base doesn't ship.
        "gdbm",
        "keyutils-libs",
        "krb5-libs",
        "cyrus-sasl-mit-libs",
        "libattr1",
        "libbrotlicommon1",
        "libbrotlidec1",
        "libcom_err",
        "libcurl-openssl4",
        "libidn2",
        "libldap",
        "libnghttp2-14",
        "libproc-2-0",
        "libpsl",
        "libunistring",
        "libverto",
        "nghttp3",
        "ngtcp2",
        "oniguruma",
        "sqlite-libs",
        "libssl3",
        "libcrypto3",
        "zlib",
        # Packages the base also uses, listed again for the parts the base
        # culls: glibc's getent, ldd and iconv, ncurses's libncursesw and
        # terminfo tools, and the full terminfo set.
        "glibc",
        "ncurses",
        "ncurses-terminfo-base",
    ],
    denyfiles = "dev-tools-denyfiles.txt",
    keepfiles = "dev-tools-keepfiles.txt",
    visibility = ["PUBLIC"],
)

# The linger marker and the login environment. The base declares the
# parent directories.
minimos.overlay(
    name = "dev-overlay-layer",
    dirs = [
        "etc/minimos",
        "etc/systemd/user",
        "var/lib",
        "var/lib/systemd",
        "var/lib/systemd/linger",
    ],
    # Lingering is an empty file named after the account. logind sees it
    # at boot and starts user@1000 with no session.
    empty_files = [
        # Tells the login wrapper to refuse any login it can't move into a
        # bounded scope under the user manager.
        "etc/minimos/require-user-scope:444",
        "var/lib/systemd/linger/exedev",
    ],
    files = {
        "etc/profile": "profile",
    },
    symlinks = {
        # Vendor user sockets for binaries the image culls.
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
