# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

SRCS = [
    "atomic.go",
    "buck.go",
    "buckjson.go",
    "cache.go",
    "cache_s3.go",
    "cache_snapshot.go",
    "cells.go",
    "cli.go",
    "config.go",
    "determine.go",
    "format.go",
    "glob.go",
    "graph.go",
    "main.go",
    "process.go",
    "quick.go",
    "sigv4.go",
    "snapshot.go",
    "universe.go",
    "vcs.go",
    "workspace.go",
]

TEST_SRCS = [
    "atomic_test.go",
    "buck_test.go",
    "buckjson_test.go",
    "cache_s3_test.go",
    "cache_snapshot_test.go",
    "cache_test.go",
    "cells_test.go",
    "cli_test.go",
    "config_test.go",
    "determine_test.go",
    "format_test.go",
    "glob_test.go",
    "graph_test.go",
    "main_test.go",
    "process_test.go",
    "quick_test.go",
    "sigv4_test.go",
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

# Cross-compiled variants of :tdutil, one per (cpu, os) we ship. tdutil is pure
# Go, so the host Go distribution covers every target: cross_binary only moves
# config//cpu and config//os, which buck/toolchains/golang/defs.bzl maps onto
# GOARCH/GOOS. The distribution itself is an exec_dep and stays on the host.
#
# This only holds while cgo_enabled = False. With cgo the link would need a C
# cross-toolchain for each of these.
#
# Note these have to be a transition (cross_binary) rather than per-target
# modifiers: modifiers apply top-down, so :tdutil-all would flatten all five
# back to the host platform. See buck/shims/cross_binary.bzl.
CROSS_PLATFORMS = [
    ("arm64", "linux"),
    ("arm64", "macos"),
    ("arm64", "windows"),
    ("x86_64", "linux"),
    ("x86_64", "windows"),
]

[
    shims.cross_binary(
        name = "tdutil-{cpu}-{os}".format(
            cpu = cpu,
            os = os,
        ),
        actual = ":tdutil",
        cpu = cpu,
        os = os,
        visibility = ["PUBLIC"],
    )
    for (cpu, os) in CROSS_PLATFORMS
]

# Every cross-compiled binary in one place. Windows targets keep their .exe
# suffix, so the collected names are already unique.
shims.filegroup(
    name = "tdutil-all",
    srcs = [
        ":tdutil-{cpu}-{os}".format(
            cpu = cpu,
            os = os,
        )
        for (cpu, os) in CROSS_PLATFORMS
    ],
    visibility = ["PUBLIC"],
)

# Runs the real buck2 against a synthetic project to pin the diagnostic text
# the universe recognizers parse. Skips when buck2 is not reachable.
shims.go_test(
    name = "integration",
    srcs = SRCS + ["integration_test.go"],
    cgo_enabled = False,
)
