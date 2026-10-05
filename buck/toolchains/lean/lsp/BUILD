# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

shims.python_binary(
    name = "smoke-test",
    main = "smoke_test.py",
)

# Runs the language server through `lake serve` against the toolchain's
# tests, with its own Buck daemon (like //buck/tests/buck2-lint), so it reads
# the checkout rather than declared inputs.
shims.run_test(
    name = "smoke",
    ci_srcs = ["buck/toolchains/lean/**"],
    dep = ":smoke-test",
)
