# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/images/minimos:defs.bzl", "minimos")

# minimos + nginx serving a static page. The fullest appliance example,
# with its own config, content and several HTTP ports.

# nginx, its upstream mime.types, and the libraries it links that the
# base doesn't ship. The .so closure finds glibc and libpcre2 in the base.
# nginx-mainline carries security fixes Wolfi hasn't backported to
# nginx-stable, and both install the same paths.
minimos.apk_culled_layer(
    name = "nginx-culled-layer",
    apks = [
        "nginx-mainline",
        "nginx-mainline-mime-types",
        "zlib",
        "libxcrypt",
        "libssl3",
        "libcrypto3",
    ],
)

# nginx.conf, the unit, and the document root. /run/nginx is the unit's
# RuntimeDirectory=, owned by its dynamic user.
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
    # exe.dev's proxy picks 80 when it's listed. 8000 and 8080 serve the
    # same page and can be shared on their own ports.
    ports = [
        "80/tcp",
        "8000/tcp",
        "8080/tcp",
    ],
    version = "0.1.0",
    visibility = ["PUBLIC"],
)
