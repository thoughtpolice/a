# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# Main bizarro binary
depot.uv.python_binary(
    name = "bizarro",
    srcs = [
        "bizarro.py.lock",
    ],
    args = [
        "--system",
        "$(location :system-prompt.txt)",
    ],
    lint_dir = "src/tools/bizarro",
    main = "bizarro.py",
    tests = [
        ":test",
        ":test-help",
        ":test-run-basic",
    ],
    visibility = ["PUBLIC"],
)

depot.export_file(
    name = "system-prompt.txt",
    src = "system-prompt.txt",
)

# Tuner binary for model tuning operations
depot.uv.python_binary(
    name = "tuner",
    srcs = [
        "tuning/tuner.py.lock",
    ],
    lint_dir = "src/tools/bizarro",
    main = "tuning/tuner.py",
    tests = [
        ":test",
        ":test-help",
        ":test-run-basic",
    ],
    visibility = ["PUBLIC"],
)

# Format target (for running formatting, not just checking)
depot.uv.tool_format(
    name = "format",
    format_dir = "src/tools/bizarro",
)

# Integration tests using the test script
depot.command_test(
    name = "test",
    cmd = ["./src/tools/bizarro/engine/t/runtests.sh"],
)

# Individual command tests for quick validation
depot.command_test(
    name = "test-help",
    cmd = [
        "./src/tools/bizarro/engine/bizarro.py",
        "--help",
    ],
)

depot.command_test(
    name = "test-run-basic",
    cmd = [
        "./src/tools/bizarro/engine/bizarro.py",
        "run",
        "--no-stats",
        "What is 2+2?",
        "--model",
        "Qwen/Qwen3-0.6B",
        "--max-tokens",
        "64",
    ],
)

# Export data files for testing
depot.filegroup(
    name = "test-data",
    srcs = glob([
        "t/data/*.jsonl",
        "t/data/*.md",
    ]),
)
