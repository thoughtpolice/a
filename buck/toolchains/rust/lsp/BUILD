# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

_SRCS = [
    "check.go",
    "main.go",
    "project.go",
]

# What rust-analyzer runs, through the launcher (./rust-project), to find
# crates and check files; see README.md.
shims.go_binary(
    name = "rust-project",
    srcs = _SRCS,
    tests = [
        ":rust-project-test",
        ":smoke",
    ],
    visibility = ["PUBLIC"],
)

shims.go_test(
    name = "rust-project-test",
    srcs = _SRCS + [
        "check_test.go",
        "project_test.go",
    ],
)

shims.go_binary(
    name = "smoke-test",
    srcs = ["smoke/main.go"],
)

# Runs rust-analyzer against tests/ the way the Helix, Claude Code and OMP
# configurations start it (checking that they agree), through the shared
# Buck daemon (like the Go and Lean language servers' tests), so it reads
# the checkout rather than declared inputs.
shims.run_test(
    name = "smoke",
    ci_srcs = [
        ".claude/marketplace/lsp/.lsp.json",
        ".helix/languages.toml",
        ".omp/lsp.json",
        "buck/toolchains/rust/**",
    ],
    dep = ":smoke-test",
    env = shims.shared_daemon_env,
)

# The launcher rust-analyzer runs.
shims.lint_files(
    name = "launcher",
    srcs = ["rust-project"],
)
