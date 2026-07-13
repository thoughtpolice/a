# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.export_file(
    name = "settings.json",
    src = "settings.json",
    visibility = ["//src/tools/brainiac/..."],
)

depot.export_file(
    name = "tdutil-pre-commit-script",
    src = "hooks/pre-commit-test.py",
)

depot.export_file(
    name = "tdutil-helper-script",
    src = "skills/buck2-target-determination/scripts/tdutil_helper.py",
)

depot.export_file(
    name = "tdutil-script-tests",
    src = "tests/test_tdutil_scripts.py",
)

depot.command_test(
    name = "test-tdutil-scripts",
    cmd = [
        "python3",
        "$(location :tdutil-script-tests)",
        "$(location :tdutil-pre-commit-script)",
        "$(location :tdutil-helper-script)",
    ],
)

depot.test_suite(
    name = "tests",
    tests = [
        ":test-tdutil-scripts",
    ],
)
