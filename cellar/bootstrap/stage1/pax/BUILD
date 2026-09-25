# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")

GCC = "cellar//bootstrap/stage1/gcc47"

MUSL = "cellar//bootstrap/stage1/musl12"

CC = GCC + ":stage3-gcc"

CRT = [
    MUSL + ":crt1.o",
    MUSL + ":crti.o",
    GCC + ":stage3-crtbeginT.o",
]

CRTN = [
    GCC + ":stage3-crtend.o",
    MUSL + ":crtn.o",
]

LIBC = [
    MUSL + ":libc.a",
    GCC + ":stage3-libgcc.a",
    MUSL + ":libc.a",
]

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
            end_objects = CRTN,
            libraries = LIBC,
            objects = CRT + [":" + name + ".o"],
            output = name,
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
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = ":archive-writer",
)

LONG_NAME = "a-directory-name-that-is-long-enough/to-need-a-pax-path-record-because/the-ustar-name-field-only-holds-one-hundred-bytes.txt"

generate(
    name = "extracted",
    args = [
        "-xf",
        "$(location :archive.tar)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
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
    command_test(
        name = name,
        args = [
            "$(location :extracted[" + member + "])",
            "$(location :" + expected + ")",
        ],
        tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
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
        capture = "cellar//bootstrap/stage1/tools:capture",
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
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            files = ["marker"],
            tool = "cellar//bootstrap/stage1/tools:expect-exit",
        ),
        command_test(
            name = "reject-" + name,
            args = [
                "$(location :" + name + "-rejected[marker])",
                "$(location :script-contents)",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
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
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    files = ["gnu-file"],
    tool = ":untar",
)

write_file(
    name = "gnu-contents",
    content = "gnu\n",
)

command_test(
    name = "gnu-header",
    args = [
        "$(location :gnu-extracted[gnu-file])",
        "$(location :gnu-contents)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
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
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            files = [kept],
            tool = ":untar",
        ),
        command_test(
            name = name + "-keeps",
            args = [
                "$(location :" + name + "-extracted[" + kept + "])",
                "$(location :" + expected + ")",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
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
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    files = ["top/prefix/run.sh"],
    tool = ":untar",
)

command_test(
    name = "command-input",
    args = [
        "$(location :command-extracted[top/prefix/run.sh])",
        "$(location :script-contents)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
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
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    files = ["top/prefix/run.sh"],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

command_test(
    name = "reject-failed-command",
    args = [
        "$(location :failed-command-rejected[top/prefix/run.sh])",
        "$(location :script-contents)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)
