# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//rust:anyhow",
    "third-party//rust:async-stream",
    "third-party//rust:blake3",
    "third-party//rust:brotli",
    "third-party//rust:bytes",
    "third-party//rust:fastcdc",
    "third-party//rust:futures",
    "third-party//rust:flate2",
    "third-party//rust:hex",
    "third-party//rust:jiff",
    "third-party//rust:sha2",
    "third-party//rust:slatedb",
    "third-party//rust:thiserror",
    "third-party//rust:tokio",
    "third-party//rust:tracing",
    "third-party//rust:zstd",
]

depot.rust_library(
    name = "storage",
    srcs = glob(["*.rs"]),
    visibility = ["//src/tools/cache-server/..."],
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

TEST_MODULES = {
    "hashing": {},
    "compression": {},
    "manifest": {},
    "cas": {},
    "cas_batch": {},
    "chunking": {
        "resources": {
            "fastcdc2020_test_vectors": ":fastcdc2020-test-vectors",
            "SekienAkashita.jpg": ":SekienAkashita.jpg",
        },
    },
    "streaming": {},
    "concurrency": {},
    "action_cache": {},
    "asset": {},
}

ALL_TEST_RESOURCES = {
    "sha256tree_test_vectors": ":sha256tree-test-vectors",
    "fastcdc2020_test_vectors": ":fastcdc2020-test-vectors",
    "SekienAkashita.jpg": ":SekienAkashita.jpg",
}

TEST_DEPS = DEPS + [
    "third-party//rust:buck-resources",
]

# Per-module test targets
[depot.rust_test(
    name = "tests-" + name,
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    resources = {"sha256tree_test_vectors": ":sha256tree-test-vectors"} | config.get("resources", {}),
    rustc_flags = ["--cfg=test_module_" + name],
    deps = TEST_DEPS,
) for name, config in TEST_MODULES.items()]

# All-in-one target
depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    resources = ALL_TEST_RESOURCES,
    rustc_flags = ["--cfg=test_module_" + name for name in TEST_MODULES],
    deps = TEST_DEPS,
)
