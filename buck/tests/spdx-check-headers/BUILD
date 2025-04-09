# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", "shims")

python_bootstrap_binary(
    name = 'check-spdx',
    main = 'main.py',
    tests = [ ':spdx-check-headers' ],
)

shims.run_test(
    name = 'spdx-check-headers',
    dep = ":check-spdx",
)
