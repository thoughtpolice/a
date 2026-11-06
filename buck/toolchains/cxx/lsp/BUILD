# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

_SRCS = [
    "db.go",
    "main.go",
]

# The wrapper the launcher (./clangd) runs, which writes the compilation
# database and starts clangd with it; see README.md.
shims.go_binary(
    name = "clangd",
    srcs = _SRCS,
    tests = [
        ":clangd-test",
        ":smoke",
    ],
    visibility = ["PUBLIC"],
)

shims.go_test(
    name = "clangd-test",
    srcs = _SRCS + ["db_test.go"],
)

shims.go_binary(
    name = "smoke-test",
    srcs = ["smoke/main.go"],
)

# Runs clangd against tests/ the way the Helix, Claude Code and OMP
# configurations start it (checking that they agree), through the shared
# Buck daemon (like the other language servers' tests), so it reads the
# checkout rather than declared inputs.
shims.run_test(
    name = "smoke",
    ci_srcs = [
        ".claude/marketplace/lsp/.lsp.json",
        ".helix/languages.toml",
        ".omp/lsp.json",
        "buck/toolchains/cxx/**",
    ],
    dep = ":smoke-test",
    env = shims.shared_daemon_env,
)

# The launcher an editor runs as its C and C++ language server.
shims.lint_files(
    name = "launcher",
    srcs = ["clangd"],
)
