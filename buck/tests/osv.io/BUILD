# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

SRCS = [
    "cargo.go",
    "generic.go",
    "harness.go",
    "main.go",
    "model.go",
    "npm.go",
    "osv.go",
    "report.go",
    "wolfi.go",
]

shims.go_binary(
    name = "osv.io",
    srcs = SRCS,
    cgo_enabled = False,
    tests = [
        ":check",
        ":unit",
    ],
)

shims.go_test(
    name = "unit",
    srcs = SRCS + ["main_test.go"],
    cgo_enabled = False,
)

# Under the internal runner this discovers one case per dependency set; each
# case batches its OSV queries in memory and reports a per-package result.
#
# The verdict is a function of osv.dev's contents, not of this repository, so
# an advisory published upstream turns every unrelated build red until the
# affected pin is bumped. The `external-data` label keeps it out of repository
# sweeps (see `[test] default_exclude_labels` in .buckconfig); naming this
# target directly still runs it, and CI does so in the `advisories` job.
shims.dynamic_test(
    name = "check",
    dep = ":osv.io",
    labels = ["external-data"],
)
