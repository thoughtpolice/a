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

EXAMPLES = [
    "ambiguous_write",
    "buggify",
    "deadline",
    "retry",
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
    ] + [":example-{}-test".format(name) for name in EXAMPLES],
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
    srcs = ["tests/consumer_test.rs"],
    crate_root = "tests/consumer_test.rs",
    deps = [
        "third-party//rust:tokio",
        ":faultline",
    ],
)

depot.rust_test(
    name = "disabled-test",
    srcs = ["tests/disabled_test.rs"],
    crate_root = "tests/disabled_test.rs",
    deps = [
        "third-party//rust:tokio",
        ":disabled",
    ],
)

[
    (
        depot.rust_binary(
            name = "example-{}".format(name),
            srcs = ["examples/{}.rs".format(name)],
            crate_root = "examples/{}.rs".format(name),
            deps = [
                "third-party//by-name/mi/mimalloc:rust",
                "third-party//rust:tokio",
                ":faultline",
            ],
        ),
        depot.run_test(
            name = "example-{}-test".format(name),
            dep = ":example-{}".format(name),
        ),
    )
    for name in EXAMPLES
]
