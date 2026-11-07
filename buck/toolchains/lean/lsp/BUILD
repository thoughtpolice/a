# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

shims.python_binary(
    name = "smoke-test",
    main = "smoke_test.py",
)

# Runs the language server through `lake serve` against the toolchain's
# tests, through the shared Buck daemon (like //buck/tests/buck2-lint), so it
# reads the checkout rather than declared inputs. The server indexes only
# the tests' package rather than every Lean module in the repository, and
# `prebuild` builds that package before the test starts.
shims.run_test(
    name = "smoke",
    ci_srcs = ["buck/toolchains/lean/**"],
    dep = ":smoke-test",
    env = shims.shared_daemon_env | {"DEPOT_LEAN_PATTERNS": "toolchains//lean/tests/..."},
    prebuild = [
        "//lean:check[cflags]",
        "//lean/tests:granular-lib",
        "//lean/tests:granular-other",
        "//lean/tests:greeting",
        "//lean/tests:hello",
        "//lean/tests:hello-test",
        "//lean/tests:native",
        "//lean/tests:native-eval",
        "//lean/tests:native-local",
        "//lean/tests:proofs",
        "//lean/tests:split-codegen",
    ],
)

# The wrappers an editor runs in place of lean and lake.
shims.lint_files(
    name = "wrappers",
    srcs = [
        "bin/lean",
        "lake",
    ],
)
