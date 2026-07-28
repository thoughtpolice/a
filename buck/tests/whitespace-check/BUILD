# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

shims.python_binary(
    name = "check-whitespace",
    main = "main.py",
    tests = [":whitespace-check"],
)

shims.run_test(
    name = "whitespace-check",
    ci_srcs = shims.ci_srcs_any_path,
    dep = ":check-whitespace",
)
