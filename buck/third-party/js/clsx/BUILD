# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@toolchains//js:defs.bzl", "js")

shims.http_archive(
    name = "archive",
    sha256 = "6320104b491ca645120e8f99589ce663ff1fb337ba80066719a011bd95320303",
    strip_prefix = "package",
    sub_targets = [
        "dist/clsx.mjs",
        "clsx.d.mts",
    ],
    type = "tar.gz",
    urls = ["https://registry.npmjs.org/clsx/-/clsx-2.1.1.tgz"],
    visibility = ["PUBLIC"],
)

js.library(
    name = "library",
    srcs = [":archive[clsx.d.mts]"],
    import_name = "clsx",
    visibility = ["PUBLIC"],
    exports = {".": ":archive[dist/clsx.mjs]"},
)
