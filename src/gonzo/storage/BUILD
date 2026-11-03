# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "//src/crates/expiring-cache:expiring-cache",
    "//src/crates/object-store-local:object-store-local",
    "//src/crates/object-store-s3:object-store-s3",
    "//src/crates/reapi-cas:reapi-cas",
    "//src/crates/write-admission:write-admission",
    "third-party//rust:async-trait",
    "third-party//rust:bytes",
    "third-party//rust:futures",
    "third-party//rust:hex",
    "third-party//rust:jiff",
    "third-party//rust:libc",
    "third-party//rust:quick_cache",
    "third-party//rust:rayon",
    "third-party//rust:sha2",
    "third-party//rust:slatedb",
    "third-party//rust:slatedb-common",
    "third-party//rust:thiserror",
    "third-party//rust:tokio",
    "third-party//rust:tracing",
]

depot.rust_library(
    name = "storage",
    srcs = glob(["*.rs"]),
    visibility = ["//src/gonzo/..."],
    deps = DEPS,
)

TEST_MODULES = [
    "manifest",
    "cas",
    "cas_batch",
    "chunking",
    "streaming",
    "concurrency",
    "action_cache",
    "asset",
    "tuning",
    "expiry",
    "lifecycle",
    "properties",
]

TEST_DEPS = DEPS + [
    "third-party//rust:fastcdc",
    "third-party//rust:hegeltest",
    "third-party//rust:tempfile",
]

# Per-module test targets
[depot.rust_test(
    name = "tests-" + name,
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    rustc_flags = ["--cfg=test_module_" + name],
    deps = TEST_DEPS,
) for name in TEST_MODULES]

# All-in-one target
depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    rustc_flags = ["--cfg=test_module_" + name for name in TEST_MODULES],
    deps = TEST_DEPS,
)
