# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
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

SOURCES = [
    "addext",
    "argmatch",
    "backupfile",
    "basename",
    "dirname",
    "getopt",
    "getopt1",
    "inp",
    "maketime",
    "partime",
    "patch",
    "pch",
    "quote",
    "quotearg",
    "quotesys",
    "util",
    "version",
    "xmalloc",
    "error",
]

FILES = [name + ".c" for name in SOURCES] + [
    "argmatch.h",
    "backupfile.h",
    "common.h",
    "dirname.h",
    "error.h",
    "getopt.h",
    "gettext.h",
    "inp.h",
    "maketime.h",
    "partime.h",
    "pch.h",
    "quote.h",
    "quotearg.h",
    "quotesys.h",
    "unlocked-io.h",
    "util.h",
    "version.h",
    "xalloc.h",
    "COPYING",
]

CONFIG_ON = [
    "D_INO_IN_DIRENT",
    "HAVE_DIRENT_H",
    "HAVE_FCNTL_H",
    "HAVE_FSEEKO",
    "HAVE_GETEUID",
    "HAVE_GETUID",
    "HAVE_INTTYPES_H",
    "HAVE_ISASCII",
    "HAVE_ISWPRINT",
    "HAVE_LIMITS_H",
    "HAVE_LONG_FILE_NAMES",
    "HAVE_MALLOC",
    "HAVE_MBRTOWC",
    "HAVE_MBSINIT",
    "HAVE_MBSTATE_T",
    "HAVE_MEMCHR",
    "HAVE_MEMCMP",
    "HAVE_MEMORY_H",
    "HAVE_MKDIR",
    "HAVE_MKTEMP",
    "HAVE_PATHCONF",
    "HAVE_RAISE",
    "HAVE_REALLOC",
    "HAVE_RMDIR",
    "HAVE_SIGACTION",
    "HAVE_SIGPROCMASK",
    "HAVE_SIGSETMASK",
    "HAVE_STDBOOL_H",
    "HAVE_STDDEF_H",
    "HAVE_STDINT_H",
    "HAVE_STDLIB_H",
    "HAVE_STRERROR",
    "HAVE_STRERROR_R",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_STRNCASECMP",
    "HAVE_STRUCT_UTIMBUF",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_TIME_H",
    "HAVE_SYS_TYPES_H",
    "HAVE_UNISTD_H",
    "HAVE_UTIME_H",
    "HAVE_VPRINTF",
    "HAVE_WCHAR_H",
    "HAVE_WCTYPE_H",
    "HAVE__BOOL",
    "PROTOTYPES",
    "STDC_HEADERS",
    "TIME_WITH_SYS_TIME",
    "HAVE_DECL_CLEARERR_UNLOCKED",
    "HAVE_DECL_FEOF_UNLOCKED",
    "HAVE_DECL_FERROR_UNLOCKED",
    "HAVE_DECL_FFLUSH_UNLOCKED",
    "HAVE_DECL_FGETS_UNLOCKED",
    "HAVE_DECL_FPUTC_UNLOCKED",
    "HAVE_DECL_FPUTS_UNLOCKED",
    "HAVE_DECL_FREAD_UNLOCKED",
    "HAVE_DECL_FREE",
    "HAVE_DECL_FWRITE_UNLOCKED",
    "HAVE_DECL_GETCHAR_UNLOCKED",
    "HAVE_DECL_GETC_UNLOCKED",
    "HAVE_DECL_GETENV",
    "HAVE_DECL_MALLOC",
    "HAVE_DECL_MKTEMP",
    "HAVE_DECL_PUTCHAR_UNLOCKED",
    "HAVE_DECL_PUTC_UNLOCKED",
    "HAVE_DECL_STRERROR",
    "HAVE_DECL_STRERROR_R",
]

CONFIG_VALUES = {
    "_GNU_SOURCE": "1",
    "PACKAGE_NAME": '"patch"',
    "PACKAGE_TARNAME": '"patch"',
    "PACKAGE_VERSION": '"2.5.9"',
    "PACKAGE_STRING": '"patch 2.5.9"',
    "PACKAGE_BUGREPORT": '"bug-patch@gnu.org"',
    "RETSIGTYPE": "void",
}

write_file(
    name = "config.h",
    content = "\n".join(["#define " + name + " 1" for name in CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in CONFIG_VALUES.items()]) + "\n",
)

download_file(
    name = "patch-2.5.9.tar.gz",
    hash = "ecb5c6469d732bcf01d6ec1afe9e64f1668caba5bfdb103c28d7f537ba3cdb8a",
    size_bytes = 201926,
    urls = ["https://mirrors.kernel.org/gnu/patch/patch-2.5.9.tar.gz"],
)

generate(
    name = "patch.tar",
    args = [
        "-dc",
        "$(location :patch-2.5.9.tar.gz)",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/gzip:gzip",
)

untar(
    name = "patch-2.5.9",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    flags = [
        "--numeric-owner",
        "-xf",
    ],
    input = ":patch.tar",
    untar = "cellar//bootstrap/stage1/tar:tar",
)

filegroup(
    name = "source",
    srcs = {path: ":patch-2.5.9[" + path + "]" for path in FILES} | {"config.h": ":config.h"},
)

[c_object(
    name = name + ".o",
    src = ":source[" + name + ".c]",
    defines = [
        "HAVE_CONFIG_H=1",
        'ed_PROGRAM="ed"',
    ],
    flags = [
        "-O2",
        "-Werror",
    ],
    logical_includes = ["."],
    logical_source = name + ".c",
    object_name = "pt" + str(i) + ".o",
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":source",
    toolchain = CC,
) for i, name in enumerate(SOURCES)]

c_binary(
    name = "patch",
    end_objects = CRTN,
    libraries = LIBC,
    objects = CRT + [":" + name + ".o" for name in SOURCES],
    output = "patch",
    toolchain = CC,
)

filegroup(
    name = "installation",
    srcs = {
        "bin/patch": ":patch",
        "share/licenses/patch/COPYING": ":source[COPYING]",
    },
)

command_test(
    name = "version",
    args = ["--version"],
    tool = ":patch",
)

filegroup(
    name = "test-source",
    srcs = {"integration.sh": "tests/integration.sh"},
)

generate(
    name = "integration",
    args = [
        "--noprofile",
        "--norc",
        "source/integration.sh",
        "$(exe :patch)",
        "$(exe cellar//bootstrap/stage1/diffutils:diff-bin)",
        "$(exe cellar//bootstrap/stage1/diffutils:cmp-bin)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "CELLAR_BOOTSTRAP_IDENTITY": "1",
        "TMPDIR": ".",
        "TZ": "UTC0",
        "LC_ALL": "C",
    },
    files = ["passed"],
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":test-source",
    tool = "cellar//bootstrap/stage1/bash:bash",
)

write_file(
    name = "passed",
    content = "passed\n",
)

command_test(
    name = "forward-reverse-context-and-reject",
    args = [
        "$(location :integration[passed])",
        "$(location :passed)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)
