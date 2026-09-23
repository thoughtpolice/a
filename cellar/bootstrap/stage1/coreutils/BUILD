# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")

MUSL = "cellar//bootstrap/stage1/musl"

CRT = [
    MUSL + ":restored-crt1.o",
    MUSL + ":restored-crti.o",
]

LIBC = [
    MUSL + ":restored-libc.a",
    "cellar//bootstrap/stage1/tcc-musl:musl2-libtcc1.a",
    MUSL + ":restored-libc.a",
]

# GNU cat is required by binutils' upstream linker-script generators.
# The remaining normal coreutils programs are added for the final userland.
CAT_LIB = [
    "closeout",
    "close-stream",
    "error",
    "exitfail",
    "full-write",
    "safe-read",
    "safe-write",
    "quote",
    "quotearg",
    "xmalloc",
    "xalloc-die",
    "version-etc",
    "version-etc-fsf",
]

REMOVE_LIB = [
    "closein",
    "argmatch",
    "cycle-check",
    "euidaccess-stat",
    "file-type",
    "group-member",
    "hash",
    "hash-pjw",
    "obstack",
    "root-dev-ino",
    "write-any-file",
    "yesno",
    "basename",
    "xstrndup",
    "stripslash",
]

REMOVE_HEADERS = [
    "lib/freadahead.h",
    "lib/xstrndup.h",
    "src/remove.h",
    "lib/argmatch.h",
    "lib/cycle-check.h",
    "lib/dev-ino.h",
    "lib/dirfd.h",
    "lib/euidaccess.h",
    "lib/euidaccess-stat.h",
    "lib/file-type.h",
    "lib/group-member.h",
    "lib/hash.h",
    "lib/hash-pjw.h",
    "lib/lstat.h",
    "lib/obstack.h",
    "lib/openat.h",
    "lib/root-dev-ino.h",
    "lib/unlinkdir.h",
    "lib/write-any-file.h",
    "lib/yesno.h",
]

HEADERS = [
    "src/system.h",
    "lib/closeout.h",
    "lib/closein.h",
    "lib/close-stream.h",
    "lib/error.h",
    "lib/exitfail.h",
    "lib/full-write.h",
    "lib/full-read.h",
    "lib/safe-read.h",
    "lib/safe-write.h",
    "lib/quote.h",
    "lib/quotearg.h",
    "lib/xalloc.h",
    "lib/version-etc.h",
    "lib/pathmax.h",
    "lib/stat-macros.h",
    "lib/timespec.h",
    "lib/gettext.h",
    "lib/verify.h",
    "lib/unlocked-io.h",
    "lib/same-inode.h",
    "lib/dirname.h",
    "lib/intprops.h",
    "lib/fpending.h",
]

FILES = REMOVE_HEADERS + [
    "src/rm.c",
    "src/remove.c",
] + ["lib/" + name + ".c" for name in REMOVE_LIB] + [
    "src/cat.c",
    "COPYING",
] + ["lib/" + name + ".c" for name in CAT_LIB] + HEADERS

# Native Linux/musl declarations, wide characters, stat layout and stdio.
CONFIG_ON = [
    "HAVE_WORKING_O_NOFOLLOW",
    "HAVE_STRUCT_DIRENT_D_TYPE",
    "HAVE_DECL_DIRFD",
    "HAVE_DECL_EUIDACCESS",
    "HAVE_EUIDACCESS",
    "HAVE_OPENAT",
    "HAVE_FDOPENDIR",
    "HAVE_GETGROUPS",
    "LSTAT_FOLLOWS_SLASHED_SYMLINK",
    "UNLINK_CANNOT_UNLINK_DIR",
    "HAVE_STDINT_H",
    "HAVE_ALLOCA",
    "HAVE_ALLOCA_H",
    "HAVE_INLINE",
    "HAVE_MKFIFO",
    "HAVE_SYS_PARAM_H",
    "HAVE_STRUCT_STAT_ST_BLOCKS",
    "TIME_WITH_SYS_TIME",
    "HAVE_SYS_TIME_H",
    "MAJOR_IN_SYSMACROS",
    "HAVE_SYS_IOCTL_H",
    "HAVE_STDIO_EXT_H",
    "HAVE___FPENDING",
    "HAVE_MBRTOWC",
    "HAVE_MBSINIT",
    "HAVE_CALLOC",
    "HAVE_STDLIB_H",
    "HAVE_STRING_H",
    "HAVE_STRERROR",
    "HAVE_DECL___FPENDING",
    "STDC_HEADERS",
    "D_INO_IN_DIRENT",
    "HAVE_DECL_FREE",
    "HAVE_DECL_MALLOC",
    "HAVE_DECL_MEMCHR",
    "HAVE_DECL_REALLOC",
    "HAVE_DECL_GETENV",
    "HAVE_DECL_LSEEK",
    "HAVE_DECL_GETLOGIN",
    "HAVE_DECL_TTYNAME",
    "HAVE_DECL_GETEUID",
    "HAVE_DECL_GETPWUID",
    "HAVE_DECL_GETGRGID",
    "HAVE_DECL_GETUID",
    "HAVE_DECL_ISBLANK",
]

CONFIG_VALUES = {
    "GETGROUPS_T": "gid_t",
    "_GNU_SOURCE": "1",
    "O_BINARY": "0",
    "O_TEXT": "0",
    "PACKAGE": '"coreutils"',
    "PACKAGE_NAME": '"GNU coreutils"',
    "PACKAGE_BUGREPORT": '"bug-coreutils@gnu.org"',
    "VERSION": '"6.10"',
    "_GL_UNUSED": "",
}

write_file(
    name = "config.h",
    content = "\n".join(["#define " + name + " 1" for name in CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in CONFIG_VALUES.items()]) + "\n",
)

write_file(
    name = "configmake.h",
    content = '#define LIBDIR "/nonexistent-bootstrap-coreutils/lib"\n#define LOCALEDIR "/nonexistent-bootstrap-coreutils/locale"\n',
)

download_file(
    name = "coreutils-6.10.tar.lzma",
    hash = "8b05bba1b2726a164e444c314e3f359604b58216be704bed8f2e028449cc6204",
    urls = ["https://mirrors.kernel.org/gnu/coreutils/coreutils-6.10.tar.lzma"],
)

generate(
    name = "coreutils.tar",
    args = [
        "--file",
        "$(location :coreutils-6.10.tar.lzma)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
)

untar(
    name = "coreutils-6.10",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    input = ":coreutils.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

filegroup(
    name = "source",
    srcs = {path: ":coreutils-6.10[" + path + "]" for path in FILES} | {
        "lib/config.h": ":config.h",
        "lib/configmake.h": ":configmake.h",
    },
)

[
    c_object(
        name = name + ".o",
        src = ":source[lib/" + name + ".c]",
        defines = ["HAVE_CONFIG_H=1"],
        flags = ["-Werror"],
        headers = [
            ":source",
            MUSL + ":headers",
        ],
        includes = [":source[lib]"],
        object_name = "c{}.o".format(i),
        toolchain = MUSL + ":tcc",
    )
    for i, name in enumerate(CAT_LIB)
]

c_library(
    name = "libcat.a",
    objects = [":" + name + ".o" for name in CAT_LIB],
    output = "libcat.a",
    toolchain = MUSL + ":tcc",
)

c_object(
    name = "cat.o",
    src = ":source[src/cat.c]",
    defines = ["HAVE_CONFIG_H=1"],
    flags = ["-Werror"],
    headers = [
        ":source",
        MUSL + ":headers",
    ],
    includes = [
        ":source[lib]",
        ":source[src]",
    ],
    object_name = "cat.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "cat",
    end_objects = [
        MUSL + ":restored-crtn.o",
    ],
    flags = [
        "-static",
        "-nostdlib",
    ],
    libraries = [":libcat.a"] + LIBC,
    objects = CRT + [
        ":cat.o",
    ],
    output = "cat",
    toolchain = MUSL + ":tcc",
)

command_test(
    name = "cat-version",
    args = ["--version"],
    tool = ":cat",
)

export_file(name = "tests/cat.sh")

[
    [
        generate(
            name = "cat-" + mode + "-output",
            args = [
                "--noprofile",
                "--norc",
                "-e",
                "$(location :tests/cat.sh)",
                "$(exe :cat)",
                "$(exe cellar//bootstrap/stage0-posix/cellar-extra:bytecmp)",
                mode,
            ],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            env = {
                "TMPDIR": ".",
                "PATH": "/nonexistent-bootstrap-tools",
                "LC_ALL": "C",
            },
            files = ["passed"],
            tool = "cellar//bootstrap/stage1/bash-bootstrap:bash",
        ),
        command_test(
            name = "cat-" + mode,
            args = [
                "$(location :cat-" + mode + "-output[passed])",
                "$(location :passed)",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        ),
    ]
    for mode in [
        "binary",
        "format",
        "number",
        "errors",
    ]
]

write_file(
    name = "passed",
    content = "passed\n",
)

# GNU rm's force and recursive semantics are needed by upstream generators.
# Linux/musl supplies descriptor-relative filesystem operations directly.
[
    c_object(
        name = name + ".o",
        src = ":source[lib/" + name + ".c]",
        # musl supplies the same stream query that gnulib otherwise implements
        # by inspecting platform-specific FILE layouts.
        defines = ["HAVE_CONFIG_H=1"] + (["freadahead=__freadahead"] if name == "closein" else []),
        flags = ["-Werror"],
        headers = [
            ":source",
            MUSL + ":headers",
        ],
        includes = [":source[lib]"],
        object_name = "r{}.o".format(i),
        toolchain = MUSL + ":tcc",
    )
    for i, name in enumerate(REMOVE_LIB)
]

c_library(
    name = "libremove.a",
    objects = [":" + name + ".o" for name in REMOVE_LIB],
    output = "libremove.a",
    toolchain = MUSL + ":tcc",
)

[
    c_object(
        name = name + ".o",
        src = ":source[src/" + name + ".c]",
        defines = ["HAVE_CONFIG_H=1"],
        flags = ["-Werror"],
        headers = [
            ":source",
            MUSL + ":headers",
        ],
        # do not sort
        includes = [
            ":source[lib]",
            ":source[src]",
        ],
        object_name = name + ".o",
        toolchain = MUSL + ":tcc",
    )
    for name in [
        "rm",
        "remove",
    ]
]

c_binary(
    name = "rm",
    end_objects = [
        MUSL + ":restored-crtn.o",
    ],
    libraries = [
        ":libremove.a",
        ":libcat.a",
    ] + LIBC,
    objects = CRT + [
        ":rm.o",
        ":remove.o",
    ],
    output = "rm",
    toolchain = MUSL + ":tcc",
)

command_test(
    name = "rm-version",
    args = ["--version"],
    tool = ":rm",
)

export_file(name = "tests/remove.c")

c_object(
    name = "rm-test.o",
    src = ":tests/remove.c",
    flags = ["-Werror"],
    headers = [MUSL + ":headers"],
    object_name = "rmtest.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "rm-test-bin",
    end_objects = [
        MUSL + ":restored-crtn.o",
    ],
    libraries = LIBC,
    objects = CRT + [
        ":rm-test.o",
    ],
    output = "rm-test",
    toolchain = MUSL + ":tcc",
)

generate(
    name = "rm-test-output",
    args = ["$(exe :rm)"],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {
        "TMPDIR": ".",
        "LC_ALL": "C",
    },
    files = ["passed"],
    tool = ":rm-test-bin",
)

command_test(
    name = "rm-files-directories-prompts",
    args = [
        "$(location :rm-test-output[passed])",
        "$(location :passed)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)
