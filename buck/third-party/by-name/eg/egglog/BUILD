# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_binary(
    name = "egglog",
    srcs = ["main.rs"],
    visibility = ["PUBLIC"],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:egglog",
        "third-party//rust:egglog-experimental",
    ],
)

depot.export_file(
    name = "test.egg",
    src = "test.egg",
)

depot.command_test(
    name = "test-driver",
    cmd = [
        "$(exe :egglog)",
        "$(location :test.egg)",
    ],
)

depot.export_file(
    name = "test-proofs.egg",
    src = "test-proofs.egg",
)

# Proof production is what downstream tools lean on; keep it exercised.
depot.command_test(
    name = "test-driver-proofs",
    cmd = [
        "$(exe :egglog)",
        "--proofs",
        "$(location :test-proofs.egg)",
    ],
)

depot.export_file(
    name = "test-experimental.egg",
    src = "test-experimental.egg",
)

# The experimental standard library is only reachable if the driver builds its
# e-graph with it; a core e-graph fails to parse this program.
depot.command_test(
    name = "test-driver-experimental",
    cmd = [
        "$(exe :egglog)",
        "$(location :test-experimental.egg)",
    ],
)
