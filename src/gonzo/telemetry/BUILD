# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "//src/crates/otel-wide:otel-wide",
    "//src/crates/slatedb-otel:slatedb-otel",
    "//src/crates/tracing-storm:tracing-storm",
    "third-party//rust:anyhow",
    "third-party//rust:opentelemetry",
]

depot.rust_library(
    name = "telemetry",
    srcs = glob(["*.rs"]),
    visibility = ["//src/gonzo/..."],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    deps = DEPS,
)
