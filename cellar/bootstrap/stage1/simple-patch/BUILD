# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/stage0-posix/mescc-tools-extra:defs.bzl", "cc")

cc(
    name = "simple-patch",
    src = "simple-patch.c",
    arch = "amd64",
    os = "Linux",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
    tools = "cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
)

write_file(
    name = "input",
    content = "prefix\nbefore\nsuffix\n",
)

write_file(
    name = "before",
    content = "before\n",
)

write_file(
    name = "after",
    content = "after\nextra\n",
)

write_file(
    name = "expected",
    content = "prefix\nafter\nextra\nsuffix\n",
)

generate(
    name = "patched",
    args = [
        "$(location :input)",
        "$(location :before)",
        "$(location :after)",
    ],
    tool = ":simple-patch",
)

command_test(
    name = "exact-block",
    args = [
        "$(location :patched)",
        "$(location :expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

write_file(
    name = "duplicate",
    content = "before\nbefore\n",
)

write_file(
    name = "empty",
    content = "",
)

# Reject invalid patches before opening the output. /dev/null keeps these
# negative tests independent of any writable test working directory.
[
    command_test(
        name = name,
        args = [
            "1",
            "$(location :simple-patch)",
            "$(location " + src + ")",
            "$(location " + before + ")",
            "$(location :after)",
            "/dev/null",
        ],
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    )
    for name, src, before in [
        ("reject-missing", ":input", ":after"),
        ("reject-ambiguous", ":duplicate", ":before"),
        ("reject-empty", ":input", ":empty"),
        ("reject-oversize", ":before", ":input"),
    ]
]
