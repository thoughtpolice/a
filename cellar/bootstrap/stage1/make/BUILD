# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "ungz", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")
load(":sources.bzl", "FILES")

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

# Static native make with POSIX jobserver and GNU alternate-directory globbing.
# Guile and dynamic object loading require runtimes outside this bootstrap.
SOURCES = [
    "ar.c",
    "arscan.c",
    "commands.c",
    "default.c",
    "dir.c",
    "expand.c",
    "file.c",
    "function.c",
    "getopt.c",
    "getopt1.c",
    "guile.c",
    "implicit.c",
    "job.c",
    "load.c",
    "loadapi.c",
    "main.c",
    "misc.c",
    "posixos.c",
    "output.c",
    "read.c",
    "remake.c",
    "rule.c",
    "signame.c",
    "strcache.c",
    "variable.c",
    "version.c",
    "vpath.c",
    "hash.c",
    "remote-stub.c",
]

CONFIG_ON = [
    "FILE_TIMESTAMP_HI_RES",
    "HAVE_ALLOCA",
    "HAVE_ALLOCA_H",
    "HAVE_ATEXIT",
    "HAVE_CLOCK_GETTIME",
    "HAVE_DIRENT_H",
    "HAVE_DUP",
    "HAVE_DUP2",
    "HAVE_FCNTL_H",
    "HAVE_FDOPEN",
    "HAVE_FILENO",
    "HAVE_FORK",
    "HAVE_GETCWD",
    "HAVE_GETGROUPS",
    "HAVE_GETHOSTBYNAME",
    "HAVE_GETHOSTNAME",
    "HAVE_GETLOADAVG",
    "HAVE_GETRLIMIT",
    "HAVE_GETTIMEOFDAY",
    "HAVE_ICONV",
    "HAVE_INTTYPES_H",
    "HAVE_ISATTY",
    "HAVE_LIMITS_H",
    "HAVE_LOCALE_H",
    "HAVE_LSTAT",
    "HAVE_MEMORY_H",
    "HAVE_MKSTEMP",
    "HAVE_MKTEMP",
    "HAVE_PIPE",
    "HAVE_PSELECT",
    "HAVE_READLINK",
    "HAVE_REALPATH",
    "HAVE_SA_RESTART",
    "HAVE_SETEGID",
    "HAVE_SETEUID",
    "HAVE_SETLINEBUF",
    "HAVE_SETLOCALE",
    "HAVE_SETREGID",
    "HAVE_SETREUID",
    "HAVE_SETRLIMIT",
    "HAVE_SETVBUF",
    "HAVE_SIGACTION",
    "HAVE_SIGSETMASK",
    "HAVE_SOCKET",
    "HAVE_STDINT_H",
    "HAVE_STDLIB_H",
    "HAVE_STRCASECMP",
    "HAVE_STRCOLL",
    "HAVE_STRDUP",
    "HAVE_STRERROR",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_STRNCASECMP",
    "HAVE_STRNDUP",
    "HAVE_STRSIGNAL",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_RESOURCE_H",
    "HAVE_SYS_SELECT_H",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_TIME_H",
    "HAVE_SYS_TYPES_H",
    "HAVE_SYS_WAIT_H",
    "HAVE_TTYNAME",
    "HAVE_UINTMAX_T",
    "HAVE_UNISTD_H",
    "HAVE_UNSIGNED_LONG_LONG_INT",
    "HAVE_VFORK",
    "HAVE_WAIT3",
    "HAVE_WAITPID",
    "HAVE_WORKING_FORK",
    "HAVE_WORKING_VFORK",
    "MAKE_JOBSERVER",
    "MAKE_SYMLINKS",
    "STDC_HEADERS",
    "TIME_WITH_SYS_TIME",
]

CONFIG_VALUES = {
    "_GNU_SOURCE": "1",
    "MAKE_HOST": '"x86_64-cellar-linux-musl"',
    "PACKAGE": '"make"',
    "PACKAGE_NAME": '"GNU Make"',
    "PACKAGE_STRING": '"GNU Make 4.2.1"',
    "PACKAGE_TARNAME": '"make"',
    "PACKAGE_VERSION": '"4.2.1"',
    "PACKAGE_BUGREPORT": '"bug-make@gnu.org"',
    "PACKAGE_URL": '"https://www.gnu.org/software/make/"',
    "VERSION": '"4.2.1"',
    "PATH_SEPARATOR_CHAR": "':'",
    "RETSIGTYPE": "void",
    "SCCS_GET": '"get"',
    "STACK_DIRECTION": "-1",
    "ST_MTIM_NSEC": "st_mtim.tv_nsec",
    "HAVE_DECL_BSD_SIGNAL": "1",
    "HAVE_DECL_SYS_SIGLIST": "0",
    "HAVE_DECL__SYS_SIGLIST": "0",
    "HAVE_DECL___SYS_SIGLIST": "0",
    "MAKE_LOAD": "0",
}

download_file(
    name = "make-4.2.1.tar.gz",
    hash = "e40b8f018c1da64edd1cc9a6fce5fa63b2e707e404e20cad91fbae337c98a5b7",
    size_bytes = 1977576,
    urls = ["https://mirrors.kernel.org/gnu/make/make-4.2.1.tar.gz"],
)

ungz(
    name = "make.tar",
    input = ":make-4.2.1.tar.gz",
    ungz = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name = "make-4.2.1",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    flags = [
        "--numeric-owner",
        "-xf",
    ],
    input = ":make.tar",
    untar = "cellar//bootstrap/stage1/tar:tar",
)

write_file(
    name = "config.h",
    content = "\n".join(["#define " + name + " 1" for name in CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in CONFIG_VALUES.items()]) + "\n",
)

filegroup(
    name = "source",
    srcs = {path: ":make-4.2.1[" + path + "]" for path in FILES} | {"config.h": ":config.h"},
)

[c_object(
    name = path.replace("/", "-") + ".o",
    src = ":source[" + path + "]",
    defines = [
        "HAVE_CONFIG_H=1",
        'LOCALEDIR="/nonexistent-bootstrap-locale"',
        'LIBDIR="/lib"',
        'INCLUDEDIR="/include"',
    ],
    flags = [
        "-O2",
        "-Werror",
    ],
    logical_includes = [
        ".",
        "glob",
    ],
    logical_source = path,
    object_name = "mk" + str(i) + ".o",
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":source",
    toolchain = CC,
) for i, path in enumerate(SOURCES + [
    "glob/glob.c",
    "glob/fnmatch.c",
])]

c_library(
    name = "libglob.a",
    objects = [
        ":glob-glob.c.o",
        ":glob-fnmatch.c.o",
    ],
    output = "libglob.a",
    toolchain = CC,
)

c_binary(
    name = "make",
    libraries = [":libglob.a"] + LIBC,
    objects = CRT + [":" + path + ".o" for path in SOURCES] + CRTN,
    output = "make",
    toolchain = CC,
)

command_test(
    name = "version",
    args = ["--version"],
    tool = ":make",
)

filegroup(
    name = "installation",
    srcs = {
        "bin/make": ":make",
        "include/gnumake.h": ":make-4.2.1[gnumake.h]",
        "share/licenses/make/COPYING": ":make-4.2.1[COPYING]",
        "share/licenses/make/COPYING.LIB": ":make-4.2.1[glob/COPYING.LIB]",
    },
)

filegroup(
    name = "tests",
    srcs = {name: "tests/" + name for name in [
        "Makefile",
        "child.mk",
        "main.c",
        "helper.c",
    ]},
)

generate(
    name = "integration",
    args = [
        "--no-print-directory",
        "-rR",
        "-j3",
        "-f",
        "source/Makefile",
        "SHELL=$(location cellar//bootstrap/stage1/bash:bash)",
        "CC=$(location " + GCC + ":stage3-xgcc)",
        "AR=$(location cellar//bootstrap/stage1/binutils:ar)",
        "CFLAGS=-O2 -g0 -frandom-seed=bootstrap -B$(location " + GCC + ":stage3-native-tools)/ -B$(location " + GCC + ":stage3-runtime)/lib/ -nostdinc -isystem $(location " + GCC + ":compiler-headers) -isystem $(location " + GCC + ":stage3-runtime[include])",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {
        "CELLAR_BOOTSTRAP_IDENTITY": "1",
        "PATH": "/nonexistent-bootstrap-path",
        "TMPDIR": ".",
        "TZ": "UTC0",
    },
    files = [
        "libhelper.a",
        "passed",
        "sample",
    ],
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":tests",
    tool = ":make",
)

write_file(
    name = "passed",
    content = "passed\n",
)

command_test(
    name = "native-build-and-jobserver",
    args = [
        "$(location :integration[passed])",
        "$(location :passed)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

write_file(
    name = "malformed.mk",
    content = "all:\nmissing recipe separator\n",
)

command_test(
    name = "diagnostics",
    args = [
        "2",
        "$(location :make)",
        "-rR",
        "-f",
        "$(location :malformed.mk)",
    ],
    env = {"PATH": "/nonexistent-bootstrap-path"},
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)
