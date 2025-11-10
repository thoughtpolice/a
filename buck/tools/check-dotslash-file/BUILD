# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Test harnesses for dotslash file verification
# The actual tests are defined in //buck/bin:dotslash-check

python_bootstrap_binary(
    name = 'check-hashes',
    main = 'hashes.py',
    visibility = ['PUBLIC'],
)

python_bootstrap_binary(
    name = 'check-windows-shim',
    main = 'windows-shim.py',
    visibility = ['PUBLIC'],
)
