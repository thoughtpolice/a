# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/images/minimos:defs.bzl", "minimos")

# minimos + memcached, the smallest composition: one culled binary and one
# unit that carries its flags, with no config files. Start here for a
# first image.

# memcached and the libraries it links that the base doesn't ship. The
# .so closure finds glibc and libseccomp in the base.
minimos.apk_culled_layer(
    name = "memcached-culled-layer",
    apks = [
        "memcached",
        "libevent",
        "cyrus-sasl-mit-libs",
        "libssl3",
        "libcrypto3",
    ],
)

# Just the unit. The base overlay declares its parent directories.
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
    # Metadata only. The unit binds loopback, so nothing outside the VM
    # can reach it without changing the flags.
    ports = ["11211/tcp"],
    version = "0.1.0",
    visibility = ["PUBLIC"],
)
