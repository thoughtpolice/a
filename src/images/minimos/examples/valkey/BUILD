# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/images/minimos:defs.bzl", "minimos")

# --------------------------------------------------------------------------
# minimos + valkey (the Redis-compatible fork): a service with its own
# config file and state directory. valkey-cli rides along so the
# coreutils-less image can verify itself over SSH.
# --------------------------------------------------------------------------

_WOLFI = "third-party//by-name/wo/wolfi"

# valkey + the TLS libs it links; glibc rides along so the .so closure
# resolves, then the denylist drops it in favour of the base's copy.
minimos.apk_culled_layer(
    name = "valkey-culled-layer",
    apks = [
        "{}:valkey.apk".format(_WOLFI),
        # Separate package: the server apk only symlinks at valkey-cli.
        "{}:valkey-cli.apk".format(_WOLFI),
        "{}:libssl3.apk".format(_WOLFI),
        "{}:libcrypto3.apk".format(_WOLFI),
        "{}:glibc.apk".format(_WOLFI),
        "{}:ld-linux.apk".format(_WOLFI),
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
