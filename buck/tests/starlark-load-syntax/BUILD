# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

shims.python_binary(
    name = "check-starlark-load-syntax",
    main = "main.py",
    tests = [":starlark-load-syntax"],
)

shims.run_test(
    name = "starlark-load-syntax",
    # Mirrors the rglob patterns in main.py. No dot forms: the checker skips any
    # path with a dot-leading component, which is also where these globs stop.
    ci_srcs = [
        "**/BUILD",
        "**/PACKAGE",
        "**/*.bzl",
    ],
    dep = ":check-starlark-load-syntax",
)
