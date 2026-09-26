# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "compare_test", "generate")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")

GCC = "cellar//bootstrap/stage1/gcc47"

CC = GCC + ":stage3-gcc"

[
    [
        c_object(
            name = name + ".o",
            src = source,
            flags = [
                "-O2",
                "-std=gnu99",
                "-Wall",
                "-Werror",
            ],
            toolchain = CC,
        ),
        c_binary(
            name = name,
            objects = [":" + name + ".o"],
            output = name,
            runtime = GCC + ":stage3-link-runtime",
            toolchain = CC,
        ),
    ]
    for name, source in [
        ("untar", "untar.c"),
        ("archive-writer", "tests/archive.c"),
    ]
]

generate(
    name = "archive.tar",
    capture = True,
    tool = ":archive-writer",
)

LONG_NAME = "a-directory-name-that-is-long-enough/to-need-a-pax-path-record-because/the-ustar-name-field-only-holds-one-hundred-bytes.txt"

generate(
    name = "extracted",
    args = [
        "-xf",
        "$(location :archive.tar)",
    ],
    chdir = True,
    directory = True,
    files = [
        LONG_NAME,
        "top/link",
        "top/prefix/run.sh",
    ],
    tool = ":untar",
)

write_file(
    name = "long-contents",
    content = "long path\n",
)

write_file(
    name = "script-contents",
    content = "exit\n",
)

[
    compare_test(
        name = name,
        actual = ":extracted[" + member + "]",
        expected = ":" + expected,
    )
    for name, member, expected in [
        ("pax-path", LONG_NAME, "long-contents"),
        ("ustar-prefix", "top/prefix/run.sh", "script-contents"),
        ("symbolic-link", "top/link", "script-contents"),
    ]
]

[
    generate(
        name = name + ".tar",
        args = [name],
        capture = True,
        tool = ":archive-writer",
    )
    for name in [
        "symbolic-parent",
        "pax-length",
        "gnu-header",
    ]
]

# untar extracts each archive's marker, then must exit 1 at a file beneath a
# symbolic link or at a pax record too short to hold its own length.
[
    [
        generate(
            name = name + "-rejected",
            args = [
                "1",
                "$(exe :untar)",
                "-xf",
                "$(location :" + name + ".tar)",
            ],
            chdir = True,
            directory = True,
            files = ["marker"],
            tool = "cellar//bootstrap/stage1/tools:expect-exit",
        ),
        compare_test(
            name = "reject-" + name,
            actual = ":" + name + "-rejected[marker]",
            expected = ":script-contents",
        ),
    ]
    for name in [
        "symbolic-parent",
        "pax-length",
    ]
]

# Old GNU headers keep access and change times where ustar has a prefix.
generate(
    name = "gnu-extracted",
    args = [
        "-xf",
        "$(location :gnu-header.tar)",
    ],
    chdir = True,
    directory = True,
    files = ["gnu-file"],
    tool = ":untar",
)

write_file(
    name = "gnu-contents",
    content = "gnu\n",
)

compare_test(
    name = "gnu-header",
    actual = ":gnu-extracted[gnu-file]",
    expected = ":gnu-contents",
)

write_file(
    name = "empty.tar",
    content = "",
)

command_test(
    name = "reject-truncated-archive",
    args = [
        "1",
        "$(exe :untar)",
        "-xf",
        "$(location :empty.tar)",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

# --only and --skip select members by path prefix; each extraction must hold
# its selected member and not the one left out.
[
    [
        generate(
            name = name + "-extracted",
            args = [
                "-xf",
                "$(location :archive.tar)",
            ] + filters,
            chdir = True,
            directory = True,
            files = [kept],
            tool = ":untar",
        ),
        compare_test(
            name = name + "-keeps",
            actual = ":" + name + "-extracted[" + kept + "]",
            expected = ":" + expected,
        ),
        command_test(
            name = name + "-leaves-out",
            args = [
                "1",
                "$(exe cellar//bootstrap/stage0-posix/cellar-extra:bytecmp)",
                "$(location :" + name + "-extracted)/" + left_out,
                "$(location :" + left_out_expected + ")",
            ],
            tool = "cellar//bootstrap/stage1/tools:expect-exit",
        ),
    ]
    for name, filters, kept, expected, left_out, left_out_expected in [
        (
            "only",
            [
                "--only",
                LONG_NAME.split("/")[0],
            ],
            LONG_NAME,
            "long-contents",
            "top/prefix/run.sh",
            "script-contents",
        ),
        (
            "skip",
            [
                "--skip",
                "top/prefix",
            ],
            LONG_NAME,
            "long-contents",
            "top/prefix/run.sh",
            "script-contents",
        ),
    ]
]

# The archive can come from a command's standard output, as from a
# decompressor, and a failing command fails the extraction.
generate(
    name = "command-extracted",
    args = [
        "-x",
        "--",
        "$(exe cellar//bootstrap/stage1/coreutils:cat)",
        "$(location :archive.tar)",
    ],
    chdir = True,
    directory = True,
    files = ["top/prefix/run.sh"],
    tool = ":untar",
)

compare_test(
    name = "command-input",
    actual = ":command-extracted[top/prefix/run.sh]",
    expected = ":script-contents",
)

generate(
    name = "failed-command-rejected",
    args = [
        "1",
        "$(exe :untar)",
        "-x",
        "--",
        "$(exe cellar//bootstrap/stage1/tools:expect-exit)",
        "1",
        "$(exe cellar//bootstrap/stage1/coreutils:cat)",
        "$(location :archive.tar)",
    ],
    chdir = True,
    directory = True,
    files = ["top/prefix/run.sh"],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

compare_test(
    name = "reject-failed-command",
    actual = ":failed-command-rejected[top/prefix/run.sh]",
    expected = ":script-contents",
)
