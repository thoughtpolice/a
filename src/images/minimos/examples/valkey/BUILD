# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/images/minimos:defs.bzl", "minimos")

# --------------------------------------------------------------------------
# minimos + valkey (the Redis-compatible fork): a service with its own
# config file and state directory. valkey-cli rides along so the
# coreutils-less image can verify itself over SSH.
# --------------------------------------------------------------------------

# valkey + the TLS libs it links; glibc comes from the base, which the
# .so closure resolves against.
minimos.apk_culled_layer(
    name = "valkey-culled-layer",
    apks = [
        "valkey",
        # Separate package: the server apk only symlinks at valkey-cli.
        "valkey-cli",
        "libssl3",
        "libcrypto3",
    ],
)

# Just the config and unit; /var/lib/valkey is the unit's
# StateDirectory, created at start and owned by its dynamic user.
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
    # Metadata only: valkey.conf binds loopback.
    ports = ["6379/tcp"],
    version = "0.1.0",
    visibility = ["PUBLIC"],
)
