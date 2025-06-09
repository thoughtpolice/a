# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", "shims")

python_bootstrap_binary(
    name = 'check-hashes',
    main = 'hashes.py',
)

python_bootstrap_binary(
    name = 'check-windows-shims',
    main = 'windows-shims.py',
)

shims.run_test(
    name = 'dotslash-check',
    dep = ":check-hashes",
)

shims.run_test(
    name = 'windows-shims-check',
    dep = ":check-windows-shims",
)
