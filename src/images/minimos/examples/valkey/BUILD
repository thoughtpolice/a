# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/images/minimos:defs.bzl", "minimos")

# minimos + valkey, the Redis-compatible fork: a service with its own
# config file and state directory. valkey-cli comes along so the image,
# which has no coreutils, can be checked over SSH.

# valkey and the TLS libraries it links. The .so closure finds glibc in
# the base.
minimos.apk_culled_layer(
    name = "valkey-culled-layer",
    apks = [
        "valkey",
        # The server package only ships a symlink to valkey-cli.
        "valkey-cli",
        "libssl3",
        "libcrypto3",
    ],
)

# The config and the unit. /var/lib/valkey is the unit's StateDirectory=,
# which systemd creates at start for the dynamic user.
minimos.overlay(
    name = "valkey-overlay-layer",
    dirs = [
        "etc",
        "etc/valkey",
    ],
    files = {
        "etc/valkey/valkey.conf": "valkey.conf",
    },
    units = [
        "valkey.service",
    ],
)

minimos.image(
    name = "minimos-valkey",
    boot_smoke_units = ["valkey.service"],
    description = "minimos + valkey key-value store (loopback)",
    layers = [
        ":valkey-culled-layer",
        ":valkey-overlay-layer",
    ],
    # Metadata only. valkey.conf binds loopback.
    ports = ["6379/tcp"],
    version = "0.1.0",
    visibility = ["PUBLIC"],
)
