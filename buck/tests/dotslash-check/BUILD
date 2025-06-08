# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", "shims")

python_bootstrap_binary(
    name = 'check-dotslash',
    main = 'main.py',
    tests = [ ':dotslash-check' ],
)

shims.run_test(
    name = 'dotslash-check',
    dep = ":check-dotslash",
)