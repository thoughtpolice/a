# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("//buck/installers:defs.bzl", "installable")

depot.rust_binary(
    name = "demo",
    srcs = ["main.rs"],
    deps = [
        "third-party//rust:anyhow",
        "third-party//rust:clap",
        "third-party//rust:tokio",
        "third-party//rust:tracing",
        "third-party//rust:uuid",
        "//buck/installers/common",
    ],
)

depot.genrule(
    name = "hello.txt",
    out = "hello.txt",
    cmd = 'echo "hello from buck2 install" > $OUT',
)

installable(
    name = "demo-test",
    files = {
        "hello.txt": ":hello.txt",
    },
    installer = ":demo",
)
