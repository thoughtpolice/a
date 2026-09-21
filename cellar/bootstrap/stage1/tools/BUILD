# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "concatenate", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/stage0-posix/mescc-tools-extra:defs.bzl", "cc")

cc(
    name = "expect-exit",
    src = "expect-exit.c",
    arch = "amd64",
    os = "Linux",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
    tools = "cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
)

[
    cc(
        name = name,
        src = name + ".c",
        arch = "amd64",
        os = "Linux",
        target_compatible_with = [
            "cellar//bootstrap/platforms:linux",
            "cellar//bootstrap/platforms:amd64",
        ],
        tools = "cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
    )
    for name in [
        "capture",
        "capture-probe",
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
    capture = ":capture",
    env = {"CAPTURE_TEST": "declared"},
    tool = ":capture-probe",
)

command_test(
    name = "capture-output",
    args = [
        "$(location :captured-output)",
        "$(location :expected-output)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

command_test(
    name = "capture-exit-status",
    args = [
        "37",
        "$(location :capture)",
        "/dev/null",
        "$(location :capture-probe)",
        "37",
        "argument",
    ],
    tool = ":expect-exit",
)

command_test(
    name = "capture-exec-failure",
    args = [
        "127",
        "$(location :capture)",
        "/dev/null",
        "/nonexistent-bootstrap-program",
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
    capture = ":capture",
    stdin = ":expected-output",
    tool = ":capture-probe",
    working_directory = ":input-directory",
)

command_test(
    name = "capture-stdin-and-directory",
    args = [
        "$(location :io-output)",
        "$(location :io-expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

command_test(
    name = "capture-missing-input",
    args = [
        "1",
        "$(location :capture)",
        "--stdin",
        "/nonexistent-bootstrap-input",
        "/dev/null",
        "$(location :capture-probe)",
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

command_test(
    name = "concatenate-order",
    args = [
        "$(location :concat-output)",
        "$(location :concat-expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)
