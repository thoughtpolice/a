# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

SRCS = [
    "README.md",
    "action.rs",
    "buggify.rs",
    "engine.rs",
    "lib.rs",
]

DEPS = [
    "third-party//by-name/mi/mimalloc:rust",
    "third-party//rust:rand",
    "third-party//rust:tokio",
]

depot.rust_library(
    name = "faultline",
    srcs = SRCS,
    crate_root = "lib.rs",
    doctests = True,
    features = ["failpoints"],
    tests = [
        ":consumer-test",
        ":faultline-unittest",
    ],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_library(
    name = "disabled",
    srcs = SRCS,
    crate = "faultline",
    crate_root = "lib.rs",
    doctests = False,
    tests = [":disabled-test"],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "faultline-unittest",
    srcs = SRCS,
    crate_root = "lib.rs",
    features = ["failpoints"],
    deps = DEPS,
)

depot.rust_test(
    name = "consumer-test",
    srcs = ["consumer_test.rs"],
    crate_root = "consumer_test.rs",
    deps = [
        "third-party//rust:tokio",
        ":faultline",
    ],
)

depot.rust_test(
    name = "disabled-test",
    srcs = ["disabled_test.rs"],
    crate_root = "disabled_test.rs",
    deps = [
        "third-party//rust:tokio",
        ":disabled",
    ],
)
