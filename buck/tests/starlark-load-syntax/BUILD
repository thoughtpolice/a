# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

python_bootstrap_binary(
    name="check-starlark-load-syntax",
    main="main.py",
    tests=[":starlark-load-syntax"],
)

shims.run_test(
    name="starlark-load-syntax",
    dep=":check-starlark-load-syntax",
)
