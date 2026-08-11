# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//rust:async-trait",
    "third-party//rust:bytes",
    "third-party//rust:chrono",
    "third-party//rust:futures",
    "third-party//rust:hex",
    "third-party//rust:hmac",
    "third-party//rust:object_store",
    "third-party//rust:percent-encoding",
    "third-party//rust:quick-xml",
    "third-party//rust:reqwest",
    "third-party//rust:serde",
    "third-party//rust:sha2",
    "third-party//rust:thiserror",
    "third-party//rust:tokio",
    "third-party//rust:tracing",
]

depot.rust_library(
    name = "s3-store",
    srcs = glob(["*.rs"]),
    visibility = ["//src/tools/cache-server/..."],
    deps = DEPS,
)

TEST_DEPS = DEPS + [
    "third-party//rust:hyper",
    "third-party//rust:hyper-util",
    "third-party//rust:s3s",
    "third-party//rust:slatedb",
]

TEST_MODULES = {
    "sigv4": {},
    "xml": {},
    "store": {},
    "slatedb": {},
}

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
