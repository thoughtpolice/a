# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", depot = "shims")

VERSION = pkg.version()

depot.http_archive(
    name = "src",
    sha256 = "907bccdfc6db768affc66d4131f4ded6c1d9dd788b21f60ba936a551a49e9ac8",
    strip_prefix = "package",
    sub_targets = [
        "web/cedar_wasm.d.ts",
        "web/cedar_wasm_bg.wasm",
    ],
    type = "tar.gz",
    urls = ["https://registry.npmjs.org/@cedar-policy/cedar-wasm/-/cedar-wasm-{}.tgz".format(VERSION)],
)

depot.alias(
    name = "wasm",
    actual = ":src[web/cedar_wasm_bg.wasm]",
)

depot.alias(
    name = "types",
    actual = ":src[web/cedar_wasm.d.ts]",
)
