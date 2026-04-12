# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/images/minimos:defs.bzl", "minimos")

# --------------------------------------------------------------------------
# minimos + nginx: a culled nginx stacked on the minimos base, started
# via systemd, serving a static page. The fullest example — a service
# with its own config, content, and multiple HTTP ports.
# --------------------------------------------------------------------------

_WOLFI = "third-party//by-name/wo/wolfi"

# nginx + the libs it links and its upstream mime.types; glibc rides
# along so the .so closure resolves, then the denylist drops it in
# favour of the base's copy. The mainline stream carries the advisory
# fixes Wolfi has not backported to nginx-stable; it installs the same
# paths, so the cull lists are stream-independent.
minimos.apk_culled_layer(
    name = "nginx-culled-layer",
    apks = [
        "{}:nginx-mainline.apk".format(_WOLFI),
        "{}:nginx-mainline-mime-types.apk".format(_WOLFI),
        "{}:libpcre2-8-0.apk".format(_WOLFI),
        "{}:zlib.apk".format(_WOLFI),
        "{}:libxcrypt.apk".format(_WOLFI),
        "{}:libssl3.apk".format(_WOLFI),
        "{}:libcrypto3.apk".format(_WOLFI),
        "{}:glibc.apk".format(_WOLFI),
        "{}:ld-linux.apk".format(_WOLFI),
    ],
)

# Our nginx.conf, the systemd unit (enabled into multi-user.target), and
# the docroot with its index.html. /run/nginx is the unit's RuntimeDirectory,
# owned by its dynamic user; access records are bounded by journald policy.
minimos.overlay(
    name = "nginx-overlay-layer",
    dirs = [
        "etc",
        "etc/nginx",
        "etc/systemd",
        "etc/systemd/system",
        "etc/systemd/system/multi-user.target.wants",
        "var",
        "var/www",
        "var/www/minimos",
    ],
    files = {
        "etc/nginx/nginx.conf": "nginx.conf",
        "var/www/minimos/index.html": "index.html",
    },
    units = [
        "nginx.service",
    ],
)

minimos.image(
    name = "minimos-nginx",
    boot_smoke_units = ["nginx.service"],
    description = "minimos + nginx serving a static page",
    layers = [
        ":nginx-culled-layer",
        ":nginx-overlay-layer",
    ],
    # exe.dev's proxy auto-picks 80; 8000/8080 are unprivileged alternates.
    ports = [
        "80/tcp",
        "8000/tcp",
        "8080/tcp",
    ],
    version = "0.1.0",
    visibility = ["PUBLIC"],
)
