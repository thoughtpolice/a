# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

shims.python_binary(
    name = "run-script",
    main = "run-script.py",
    visibility = ["PUBLIC"],
)

shims.copy_files(
    name = "tests",
    srcs = {
        "main.py": "tests/main.py",
        "pkg/helper.py": "tests/pkg/helper.py",
    },
)

# The script runs as __main__ with its own arguments, and imports a module
# from beside itself.
shims.command_test(
    name = "test-run-script",
    script = """
        test "`$(exe :run-script) $(location :tests)/main.py one two`" = "helper: __main__ ['one', 'two']"
    """,
)
