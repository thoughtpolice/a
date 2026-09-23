# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "ungz", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")

PATCHES = {
    "lib/getdate.y": ("#include <stdio.h>", "#include <stdio.h>\n#include <stdlib.h>"),
    "lib/getopt.c": ("#include <stdio.h>", "#include <stdio.h>\n#include <string.h>"),
    "lib/modechange.c": ("oatoi (s)\n     char *s;", "oatoi (s)\n     const char *s;"),
}

GCC = "cellar//bootstrap/stage1/gcc40-rebuilt"

MUSL = "cellar//bootstrap/stage1/musl12"

CC = GCC + ":gcc"

CRT = [
    MUSL + ":crt1.o",
    MUSL + ":crti.o",
    GCC + ":crtbeginT.o",
]

CRTN = [
    GCC + ":crtend.o",
    MUSL + ":crtn.o",
]

LIBC = [
    MUSL + ":libc.a",
    GCC + ":libgcc.a",
    MUSL + ":libc.a",
]

SOURCES = [
    "arith",
    "buffer",
    "compare",
    "create",
    "delete",
    "extract",
    "incremen",
    "list",
    "mangle",
    "misc",
    "names",
    "open3",
    "rtapelib",
    "tar",
    "update",
]

LIBRARY = [
    "argmatch",
    "backupfile",
    "error",
    "getopt",
    "getopt1",
    "getversion",
    "modechange",
    "msleep",
    "xgetcwd",
    "xmalloc",
    "xstrdup",
]

HEADERS = [
    "src/arith.h",
    "src/common.h",
    "src/rmt.h",
    "src/system.h",
    "src/tar.h",
    "lib/argmatch.h",
    "lib/backupfile.h",
    "lib/error.h",
    "lib/fnmatch.h",
    "lib/getdate.h",
    "lib/getopt.h",
    "lib/getpagesize.h",
    "lib/modechange.h",
    "lib/pathmax.h",
]

# HAVE_NETDB_H selects obsolete rexec transport in this release, not merely
# the header. Leave it unset for musl; explicit --rsh-command remains available.
FEATURES = [
    "STDC_HEADERS",
    "TIME_WITH_SYS_TIME",
    "PROTOTYPES",
    "HAVE_ALLOCA",
    "HAVE_ALLOCA_H",
    "HAVE_FNMATCH",
    "HAVE_MMAP",
    "HAVE_ST_BLKSIZE",
    "HAVE_ST_BLOCKS",
    "HAVE_VPRINTF",
    "MAJOR_IN_SYSMACROS",
    "HAVE_GETGRGID",
    "HAVE_GETPWUID",
    "HAVE_LC_MESSAGES",
    "HAVE_MKNOD",
    "HAVE_STPCPY",
    "HAVE_UTIME_H",
    "HAVE_BASENAME",
    "HAVE_EXECLP",
    "HAVE_FSYNC",
    "HAVE_FTRUNCATE",
    "HAVE_GETCWD",
    "HAVE_GETPAGESIZE",
    "HAVE_ISASCII",
    "HAVE_LCHOWN",
    "HAVE_MEMSET",
    "HAVE_MEMCPY",
    "HAVE_MKDIR",
    "HAVE_MKFIFO",
    "HAVE_MUNMAP",
    "HAVE_POLL",
    "HAVE_PUTENV",
    "HAVE_RENAME",
    "HAVE_RMDIR",
    "HAVE_SELECT",
    "HAVE_SETENV",
    "HAVE_SETLOCALE",
    "HAVE_STRCASECMP",
    "HAVE_STRCHR",
    "HAVE_STRERROR",
    "HAVE_STRSTR",
    "HAVE_USLEEP",
    "HAVE_DIRENT_H",
    "HAVE_FCNTL_H",
    "HAVE_LIMITS_H",
    "HAVE_LOCALE_H",
    "HAVE_MALLOC_H",
    "HAVE_MEMORY_H",
    "HAVE_NL_TYPES_H",
    "HAVE_POLL_H",
    "HAVE_STRING_H",
    "HAVE_SYS_MTIO_H",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_TIME_H",
    "HAVE_SYS_WAIT_H",
    "HAVE_UNISTD_H",
]

CONFIG = {
    "_GNU_SOURCE": "1",
    "PACKAGE": "\"tar\"",
    "VERSION": "\"1.12\"",
    "DEFAULT_ARCHIVE": "\"-\"",
    "DEFAULT_BLOCKING": "20",
    "SIZEOF_UNSIGNED_LONG": "8",
    "SIZEOF_LONG_LONG": "8",
    "STACK_DIRECTION": "-1",
    "RETSIGTYPE": "void",
    "MTIO_CHECK_FIELD": "mt_type",
    "LOCALEDIR": "\"/nonexistent-bootstrap-locale\"",
    "REMOTE_SHELL": "\"/nonexistent-bootstrap-rsh\"",
}

FILES = ["src/" + n + ".c" for n in SOURCES] + ["lib/" + n + ".c" for n in LIBRARY] + HEADERS + [
    "lib/getdate.y",
    "COPYING",
]

download_file(
    name = "tar-1.12.tar.gz",
    hash = "c6c37e888b136ccefab903c51149f4b7bd659d69d4aea21245f61053a57aa60a",
    size_bytes = 867759,
    urls = ["https://mirrors.kernel.org/gnu/tar/tar-1.12.tar.gz"],
)

ungz(
    name = "tar.tar",
    input = ":tar-1.12.tar.gz",
    ungz = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name = "tar-1.12",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    input = ":tar.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

write_file(
    name = "config.h",
    content = "/* Reviewed native GCC/musl configuration. */\n" +
              "\n".join(["#define " + name + " 1" for name in FEATURES]) + "\n" +
              "\n".join(["#define " + name + " " + value for name, value in CONFIG.items()]) + "\n",
)

# Native unsigned-long formatting, unused by the reference's 32-bit recipe.
generate(
    name = "arith.h",
    args = [
        "s/%uld/%lu/g;s/%09uld/%09lu/g;s/%04uld/%04lu/g",
        "$(location :tar-1.12[src/arith.h])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

[
    exact_patch(
        name = path.replace("/", "-"),
        src = ":tar-1.12[" + path + "]",
        after = after,
        before = before,
    )
    for path, (before, after) in PATCHES.items()
]

generate(
    name = "getdate-parser",
    args = [
        "--no-lines",
        "--output=getdate.c",
        "$(location :lib-getdate.y)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    files = ["getdate.c"],
    tool = "cellar//bootstrap/stage1/bison:bison",
)

export_file(name = "patches/full-names.patch")

exact_patch(
    name = "list.c",
    src = ":tar-1.12[src/list.c]",
    patch = ":patches/full-names.patch",
)

filegroup(
    name = "source",
    srcs = {p: ":tar-1.12[" + p + "]" for p in FILES if p not in [
        "src/arith.h",
        "src/list.c",
    ] and p not in PATCHES} | {p: ":" + p.replace("/", "-") for p in PATCHES} | {
        "config.h": ":config.h",
        "src/arith.h": ":arith.h",
        "src/list.c": ":list.c",
        "lib/getdate.c": ":getdate-parser[getdate.c]",
    },
)

GROUPS = {
    "src": SOURCES,
    "lib": LIBRARY + ["getdate"],
}

[
    c_object(
        name = group + "-" + name + ".o",
        src = ":source[" + group + "/" + name + ".c]",
        defines = ["HAVE_CONFIG_H=1"],
        flags = [
            "-O2",
            "-Werror",
        ],
        headers = [":source"],
        logical_includes = [
            ".",
            "lib",
            "src",
        ],
        logical_source = group + "/" + name + ".c",
        object_name = group + str(i) + ".o",
        source_alias = "cellar//bootstrap/stage1/tools:source-alias",
        source_tree = ":source",
        toolchain = CC,
    )
    for group, names in GROUPS.items()
    for i, name in enumerate(names)
]

c_library(
    name = "libtar.a",
    objects = [":lib-" + n + ".o" for n in LIBRARY + ["getdate"]],
    output = "libtar.a",
    toolchain = CC,
)

c_binary(
    name = "tar",
    end_objects = CRTN,
    libraries = [":libtar.a"] + LIBC,
    objects = CRT + [":src-" + n + ".o" for n in SOURCES],
    output = "tar",
    toolchain = CC,
)

command_test(
    name = "version",
    args = ["--version"],
    tool = ":tar",
)

filegroup(
    name = "test-headers",
    srcs = {"getdate.h": ":source[lib/getdate.h]"},
)

[
    [
        c_object(
            name = name + ".o",
            src = "tests/" + name + ".c",
            flags = [
                "-O2",
                "-Werror",
            ],
            headers = [":source"],
            includes = [":test-headers"],
            toolchain = CC,
        ),
        c_binary(
            name = name,
            end_objects = CRTN,
            libraries = [":libtar.a"] + LIBC,
            objects = CRT + [":" + name + ".o"],
            toolchain = CC,
        ),
    ]
    for name in [
        "dates",
        "roundtrip",
    ]
]

command_test(
    name = "date-parser",
    env = {"TZ": "UTC0"},
    tool = ":dates",
)

generate(
    name = "roundtrip-work",
    args = ["$(exe :tar)"],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TZ": "UTC0"},
    files = ["passed"],
    tool = ":roundtrip",
)

write_file(
    name = "expected",
    content = "passed\n",
)

command_test(
    name = "archive-roundtrip",
    args = [
        "$(location :roundtrip-work[passed])",
        "$(location :expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

filegroup(
    name = "installation",
    srcs = {
        "bin/tar": ":tar",
        "share/licenses/tar/COPYING": ":tar-1.12[COPYING]",
    },
)

[export_file(name = "tests/" + name + ".c") for name in [
    "dates",
    "roundtrip",
]]
