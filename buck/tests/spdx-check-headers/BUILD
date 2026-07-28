# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

shims.python_bootstrap_binary(
    name = "check-spdx",
    main = "main.py",
    tests = [":spdx-check-headers"],
)

shims.run_test(
    name = "spdx-check-headers",
    args = ["$(location //buck/bin/extra:jj)"],
    ci_srcs = shims.ci_srcs_any_path,
    dep = ":check-spdx",
)
