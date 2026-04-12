# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/images/minimos:defs.bzl", "minimos")

# --------------------------------------------------------------------------
# minimos + memcached: the smallest possible composition. One culled
# binary, one systemd unit carrying its flags, no config files — if
# you're building your first image on minimos, start from this one.
# --------------------------------------------------------------------------

_WOLFI = "third-party//by-name/wo/wolfi"

# memcached + the libs it links; glibc and libseccomp ride along so the
# .so closure resolves, then the denylist drops them in favour of the
# base's copies.
minimos.apk_culled_layer(
    name = "memcached-culled-layer",
    apks = [
        "{}:memcached.apk".format(_WOLFI),
        "{}:libevent.apk".format(_WOLFI),
        "{}:cyrus-sasl-mit-libs.apk".format(_WOLFI),
        "{}:libssl3.apk".format(_WOLFI),
        "{}:libcrypto3.apk".format(_WOLFI),
        "{}:libseccomp.apk".format(_WOLFI),
        "{}:glibc.apk".format(_WOLFI),
        "{}:ld-linux.apk".format(_WOLFI),
    ],
)

# Just the unit; parent dirs for it come from the base overlay.
minimos.overlay(
    name = "memcached-overlay-layer",
    units = [
        "memcached.service",
    ],
)

minimos.image(
    name = "minimos-memcached",
    boot_smoke_units = ["memcached.service"],
    description = "minimos + memcached (loopback, in-VM verification)",
    layers = [
        ":memcached-culled-layer",
        ":memcached-overlay-layer",
    ],
    # Metadata only: the unit binds loopback, so nothing is reachable
    # from outside the VM without editing the flags.
    ports = ["11211/tcp"],
    version = "0.1.0",
    visibility = ["PUBLIC"],
)
