# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//rust:blake3",
    "third-party//rust:brotli",
    "third-party//rust:bytes",
    "third-party//rust:fastcdc",
    "third-party//rust:flate2",
    "third-party//rust:hex",
    "third-party//rust:sha2",
    "third-party//rust:thiserror",
    "third-party//rust:tokio",
    "third-party//rust:zstd",
]

depot.rust_library(
    name = "reapi-cas",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    tests = [":tests"],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.export_file(
    name = "sha256tree-test-vectors",
    src = "testdata/sha256tree_test_vectors.txt",
)

depot.export_file(
    name = "fastcdc2020-test-vectors",
    src = "testdata/fastcdc2020_test_vectors.txt",
)

depot.http_file(
    name = "SekienAkashita.jpg",
    sha256 = "d9e749d9367fc908876749d6502eb212fee88c9a94892fb07da5ef3ba8bc39ed",
    urls = [
        "https://raw.githubusercontent.com/nlfiedler/fastcdc-rs/49c3d0b/test/fixtures/SekienAkashita.jpg",
    ],
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    resources = {
        "SekienAkashita.jpg": ":SekienAkashita.jpg",
        "fastcdc2020_test_vectors": ":fastcdc2020-test-vectors",
        "sha256tree_test_vectors": ":sha256tree-test-vectors",
    },
    deps = DEPS + [
        "third-party//rust:buck-resources",
    ],
)
