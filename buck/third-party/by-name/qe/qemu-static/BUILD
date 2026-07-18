# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version().split("+", 1)[0]

shims.http_archive(
    name = "qemu-static",
    sha256 = "b22f6cf575f5c8266d70f64b8ecc754f61c2986e9cc9e00607453baa5fe7352b",
    strip_prefix = "qemu-linux-x86_64-{VERSION}".format(VERSION = VERSION),
    type = "tar.xz",
    urls = [
        "https://github.com/ziglang/qemu-static/releases/download/{VERSION}/qemu-linux-x86_64-{VERSION}.tar.xz".format(VERSION = VERSION),
    ],
)

shims.export_file(
    name = "run-swtpm",
    src = "run-swtpm",
)
