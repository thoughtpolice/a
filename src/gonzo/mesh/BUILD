# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//rust:argon2",
    "third-party//rust:blake3",
    "third-party//rust:hex",
    "third-party//rust:hyper-util",
    "third-party//rust:iroh",
    "third-party//rust:iroh-tickets",
    "third-party//rust:thiserror",
    "third-party//rust:tokio",
    "third-party//rust:tonic",
    "third-party//rust:tower",
    "third-party//rust:tracing",
    "//src/crates/accept",
    "//src/crates/iroh-boring",
    "//src/crates/iroh-dial",
    "//src/crates/iroh-rendezvous",
]

# words.rs is EFF's wordlist, and keeps EFF's copyright line.
SRCLINT = {"spdx_exclude": ["words.rs"]}

depot.rust_library(
    name = "mesh",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    srclint = SRCLINT,
    tests = [":tests"],
    visibility = ["//src/gonzo/..."],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    srclint = SRCLINT,
    deps = DEPS + [
        "third-party//rust:dial9",
        "third-party//rust:tempfile",
        "third-party//rust:tonic-health",
        "//src/crates/dial9-tonic",
        "//src/crates/iroh-utils",
    ],
)
