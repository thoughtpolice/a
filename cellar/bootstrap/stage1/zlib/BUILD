# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")

GCC = "cellar//bootstrap/stage1/gcc13"

MUSL = "cellar//bootstrap/stage1/musl12"

CC = GCC + ":stage3-gcc"

SOURCE = ":zlib-1.3.2"

CAPTURE = "cellar//bootstrap/stage1/tools:capture"

CHDIRENV = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv"

BYTECMP = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp"

download_file(
    name = "zlib-1.3.2.tar.gz",
    hash = "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16",
    size_bytes = 1502830,
    urls = ["https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz"],
)

generate(
    name = "zlib.tar",
    args = [
        "-dc",
        "$(location :zlib-1.3.2.tar.gz)",
    ],
    capture = CAPTURE,
    tool = "cellar//bootstrap/stage1/gzip:gzip",
)

# The Makefile's OBJZ and OBJG lists.
SOURCES = [
    "adler32",
    "crc32",
    "deflate",
    "infback",
    "inffast",
    "inflate",
    "inftrees",
    "trees",
    "zutil",
    "compress",
    "uncompr",
    "gzclose",
    "gzlib",
    "gzread",
    "gzwrite",
]

HEADERS = [
    "crc32.h",
    "deflate.h",
    "gzguts.h",
    "inffast.h",
    "inffixed.h",
    "inflate.h",
    "inftrees.h",
    "trees.h",
    "zlib.h",
    "zutil.h",
]

TESTS = [
    "test/example.c",
    "test/minigzip.c",
]

FILES = [name + ".c" for name in SOURCES] + HEADERS + TESTS + [
    "LICENSE",
    "zconf.h.in",
]

untar(
    name = SOURCE[1:],
    chdirenv = CHDIRENV,
    files = FILES,
    flags = ["-xf"],
    input = ":zlib.tar",
    only = FILES,
    untar = "cellar//bootstrap/stage1/pax:untar",
)

# configure copies zconf.h.in over the shipped zconf.h and records that
# unistd.h and stdarg.h exist.
generate(
    name = "zconf.h",
    args = [
        "-e",
        "/^#if HAVE_UNISTD_H-0.* may be/s/ HAVE_UNISTD_H-0\\(.*\\) may be/ 1\\1 was/",
        "-e",
        "/^#if HAVE_STDARG_H-0.* may be/s/ HAVE_STDARG_H-0\\(.*\\) may be/ 1\\1 was/",
        "$(location {}[zconf.h.in])".format(SOURCE),
    ],
    capture = CAPTURE,
    output = "zconf.h",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

# The configured source directory, as the in-tree build compiles it.
filegroup(
    name = "source",
    srcs = {path: "{}[{}]".format(SOURCE, path) for path in FILES} | {"zconf.h": ":zconf.h"},
)

# What configure gives GCC on Linux for a static library: musl has off64_t
# with _LARGEFILE64_SOURCE, and GCC hides symbols shared between sources.
CFLAGS = [
    "-O3",
    "-fPIC",
    "-D_LARGEFILE64_SOURCE=1",
    "-DHAVE_HIDDEN",
]

[
    c_object(
        name = name + ".o",
        src = ":source[{}.c]".format(name),
        flags = CFLAGS,
        headers = [":source"],
        object_name = name + ".o",
        toolchain = CC,
    )
    for name in SOURCES
]

c_library(
    name = "libz.a",
    objects = [":{}.o".format(name) for name in SOURCES],
    output = "libz.a",
    toolchain = CC,
)

filegroup(
    name = "headers",
    srcs = {
        "zconf.h": ":zconf.h",
        "zlib.h": SOURCE + "[zlib.h]",
    },
)

filegroup(
    name = "installation",
    srcs = {
        "include/zconf.h": ":zconf.h",
        "include/zlib.h": SOURCE + "[zlib.h]",
        "lib/libz.a": ":libz.a",
        "share/licenses/zlib/LICENSE": SOURCE + "[LICENSE]",
    },
)

# make test runs example and a minigzip round trip, built once as is and
# once with a 64-bit off_t, which musl always has.
write_file(
    name = "hello",
    content = "hello world\n",
)

write_file(
    name = "passed",
    content = "passed\n",
)

[
    [
        c_object(
            name = "{}{}.o".format(program, suffix),
            src = ":source[test/{}.c]".format(program),
            flags = CFLAGS + flags,
            headers = [":source"],
            includes = [":source"],
            object_name = program + ".o",
            toolchain = CC,
        )
        for program in [
            "example",
            "minigzip",
        ]
    ] + [
        c_binary(
            name = program + suffix,
            end_objects = [
                GCC + ":stage3-crtend.o",
                MUSL + ":crtn.o",
            ],
            libraries = [
                ":libz.a",
                MUSL + ":libc.a",
                GCC + ":stage3-libgcc.a",
                MUSL + ":libc.a",
            ],
            objects = [
                MUSL + ":crt1.o",
                MUSL + ":crti.o",
                GCC + ":stage3-crtbeginT.o",
                ":{}{}.o".format(program, suffix),
            ],
            output = program + suffix,
            toolchain = CC,
        )
        for program in [
            "example",
            "minigzip",
        ]
    ] + [
        generate(
            name = "hello{}.gz".format(suffix),
            capture = CAPTURE,
            stdin = ":hello",
            tool = ":minigzip" + suffix,
        ),
        generate(
            name = "hello{}".format(suffix) + "-decompressed",
            args = ["-d"],
            capture = CAPTURE,
            stdin = ":hello{}.gz".format(suffix),
            tool = ":minigzip" + suffix,
        ),
        command_test(
            name = "minigzip{}-test".format(suffix),
            args = [
                "$(location :hello{}-decompressed)".format(suffix),
                "$(location :hello)",
            ],
            tool = BYTECMP,
        ),
        # example writes and reads back a gzip file in its working
        # directory, and fails on any mismatch.
        generate(
            name = "example{}-run".format(suffix),
            args = [
                "--noprofile",
                "--norc",
                "-ec",
                "\"$1\" example.gz > example.log; printf 'passed\\n' > result",
                "example",
                "$(exe :example{})".format(suffix),
            ],
            chdir = CHDIRENV,
            directory = True,
            env = {"PATH": "/nonexistent-bootstrap-path"},
            files = ["result"],
            tool = "cellar//bootstrap/stage1/bash:bash",
        ),
        command_test(
            name = "example{}-test".format(suffix),
            args = [
                "$(location :example{}-run[result])".format(suffix),
                "$(location :passed)",
            ],
            tool = BYTECMP,
        ),
    ]
    for suffix, flags in {
        "": [],
        "64": ["-D_FILE_OFFSET_BITS=64"],
    }.items()
]
