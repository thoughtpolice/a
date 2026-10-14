# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "go_module_binary")
load(":gopls.bzl", "GOPLS_LOCK")

# The gopls release the language server runs. After changing it, regenerate
# gopls.bzl, which pins every module it builds from, with the command below.
GOPLS = "golang.org/x/tools/gopls@v0.23.0"

go_module_binary(
    name = "gopls",
    ldflags = ["-X main.version=" + GOPLS.split("@")[1]],
    lock = GOPLS_LOCK,
    module = GOPLS,
    regenerate = "buck2 run toolchains//golang/lsp:lock -- -w buck/toolchains/golang/lsp/gopls.bzl",
    visibility = ["PUBLIC"],
)

shims.go_binary(
    name = "lock-generator",
    srcs = ["lock.go"],
    visibility = [],
)

shims.command(
    name = "lock",
    args = [
        "-module",
        GOPLS,
        "-name",
        "GOPLS_LOCK",
    ],
    dep = ":lock-generator",
)

# Builds :gopls from its module proxy files; see defs.bzl.
shims.go_binary(
    name = "modbuild",
    srcs = ["modbuild.go"],
    visibility = [],
)

# The GOPACKAGESDRIVER that the launcher (./gopls) hands to gopls.
shims.go_binary(
    name = "driver",
    srcs = ["driver.go"],
    tests = [
        ":driver-test",
        ":smoke",
    ],
    visibility = ["PUBLIC"],
)

shims.go_test(
    name = "driver-test",
    srcs = [
        "driver.go",
        "driver_test.go",
    ],
)

shims.python_binary(
    name = "smoke-test",
    main = "smoke_test.py",
)

# Runs gopls through the launcher against tests/, the way the Helix, Claude
# Code and OMP configurations start it (checking that they agree), with its
# own Buck daemon (like the Lean language server's test), so it reads the
# checkout rather than declared inputs.
shims.run_test(
    name = "smoke",
    ci_srcs = [
        ".claude/marketplace/lsp/.lsp.json",
        ".helix/languages.toml",
        ".omp/lsp.json",
        "buck/toolchains/golang/**",
    ],
    dep = ":smoke-test",
)

# The launcher an editor runs as its Go language server.
shims.lint_files(
    name = "launcher",
    srcs = ["gopls"],
)
