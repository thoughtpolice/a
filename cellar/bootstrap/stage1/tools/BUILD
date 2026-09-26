# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "compare_test", "concatenate", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/stage0-posix/mescc-tools-extra:defs.bzl", "cc")

# M2-Mesoplanet builds these helpers with the stage0 tools, so every stage
# can use them.
[
    cc(
        name = name,
        src = name + ".c",
        arch = "amd64",
        os = "Linux",
        tools = "cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
    )
    for name in [
        "capture",
        "capture-probe",
        "expect-exit",
        "source-alias",
    ]
]

write_file(
    name = "expected-output",
    content = "declared:argument\n",
)

generate(
    name = "captured-output",
    args = [
        "0",
        "argument",
    ],
    capture = True,
    env = {"CAPTURE_TEST": "declared"},
    tool = ":capture-probe",
)

compare_test(
    name = "capture-output",
    actual = ":captured-output",
    expected = ":expected-output",
)

command_test(
    name = "capture-exit-status",
    args = [
        "37",
        "$(exe :capture)",
        "/dev/null",
        "$(exe :capture-probe)",
        "37",
        "argument",
    ],
    tool = ":expect-exit",
)

# Missing executables stay inside a declared input directory, including in
# process traces used to audit the bootstrap's execution closure.
filegroup(
    name = "missing-program-directory",
    srcs = {},
)

command_test(
    name = "capture-exec-failure",
    args = [
        "127",
        "$(exe :capture)",
        "/dev/null",
        "$(location :missing-program-directory)/missing-program",
    ],
    tool = ":expect-exit",
)

filegroup(
    name = "input-directory",
    srcs = {"relative-input": ":expected-output"},
)

write_file(
    name = "io-expected",
    content = "declared:argument\ndeclared:argument\n",
)

generate(
    name = "io-output",
    args = [
        "io",
        "relative-input",
    ],
    capture = True,
    stdin = ":expected-output",
    tool = ":capture-probe",
    working_directory = ":input-directory",
)

compare_test(
    name = "capture-stdin-and-directory",
    actual = ":io-output",
    expected = ":io-expected",
)

command_test(
    name = "capture-missing-input",
    args = [
        "1",
        "$(exe :capture)",
        "--stdin",
        "/nonexistent-bootstrap-input",
        "/dev/null",
        "$(exe :capture-probe)",
    ],
    tool = ":expect-exit",
)

write_file(
    name = "concat-tail",
    content = "tail",
)

write_file(
    name = "concat-expected",
    content = "taildeclared:argument\ntail",
)

concatenate(
    name = "concat-output",
    inputs = [
        ":concat-tail",
        ":expected-output",
        ":concat-tail",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
)

compare_test(
    name = "concatenate-order",
    actual = ":concat-output",
    expected = ":concat-expected",
)
