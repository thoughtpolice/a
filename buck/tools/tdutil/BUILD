# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

SRCS = [
    "atomic.go",
    "buck.go",
    "buckjson.go",
    "cells.go",
    "cli.go",
    "determine.go",
    "format.go",
    "glob.go",
    "graph.go",
    "main.go",
    "process.go",
    "quick.go",
    "snapshot.go",
    "universe.go",
    "vcs.go",
    "workspace.go",
]

TEST_SRCS = [
    "atomic_test.go",
    "buck_test.go",
    "buckjson_test.go",
    "cells_test.go",
    "cli_test.go",
    "determine_test.go",
    "format_test.go",
    "glob_test.go",
    "graph_test.go",
    "main_test.go",
    "process_test.go",
    "quick_test.go",
    "snapshot_test.go",
    "universe_test.go",
    "vcs_test.go",
    "workspace_test.go",
]

shims.go_binary(
    name = "tdutil",
    srcs = SRCS,
    cgo_enabled = False,
    link_mode = "internal",
    tests = [
        ":integration",
        ":unit",
    ],
    visibility = ["PUBLIC"],
)

shims.go_test(
    name = "unit",
    srcs = SRCS + TEST_SRCS,
    cgo_enabled = False,
)

# Runs the real buck2 against a synthetic project to pin the diagnostic text
# the universe recognizers parse. Skips when buck2 is not reachable.
shims.go_test(
    name = "integration",
    srcs = SRCS + ["integration_test.go"],
    cgo_enabled = False,
)
