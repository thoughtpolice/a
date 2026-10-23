# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

LIB_SRCS = glob(
    ["**/*.rs"],
    exclude = ["main.rs"],
)

# The sources keep upstream's copyright line, whose years srclint's check is
# not written for; see PACKAGE and LICENSE for the attribution.
LIB_SRCLINT = {"spdx_exclude": LIB_SRCS}

LIB_DEPS = [
    "third-party//rust:anyhow",
    "third-party//rust:clap",
    "third-party//rust:regex",
]

# upstream is edition 2018; moving the sources forward is its own change
EDITION = "2018"

depot.rust_library(
    name = "lib",
    srcs = LIB_SRCS,
    crate = "absh",
    crate_root = "lib.rs",
    edition = EDITION,
    srclint = LIB_SRCLINT,
    tests = [":lib-unittest"],
    deps = LIB_DEPS,
)

depot.rust_test(
    name = "lib-unittest",
    srcs = LIB_SRCS,
    crate = "absh",
    crate_root = "lib.rs",
    edition = EDITION,
    srclint = LIB_SRCLINT,
    deps = LIB_DEPS,
)

depot.rust_binary(
    name = "absh",
    srcs = ["main.rs"],
    crate_root = "main.rs",
    edition = EDITION,
    srclint = {"spdx_exclude": ["main.rs"]},
    visibility = ["PUBLIC"],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:anyhow",
        "third-party//rust:clap",
        "third-party//rust:rand",
        "third-party//rust:wait4",
        ":lib",
    ],
)

# A short A/B run: two iterations print the statistics and a third ends it.
# absh logs under $HOME/.absh, so point it at a scratch home.
depot.command_test(
    name = "test-ab",
    script = """
home="`mktemp -d`"
trap 'rm -rf "$home"' EXIT
HOME="$home" $(exe :absh) -a 'true' -b 'sleep 0.01' -n 3 -m
test -s "$home"/.absh/logs/last/log
""",
)
