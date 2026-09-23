# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")

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

# The archive already contains the gnulib import pinned by import-gnulib.config:
# 8e128ebf42e16c8631f971a68f188c30962818be.
PROGRAMS = {
    "find": [
        "find/find",
        "find/fstype",
        "find/parser",
        "find/pred",
        "find/tree",
        "find/util",
        "find/version",
    ],
    "xargs": [
        "xargs/xargs",
        "find/version",
    ],
    "locate": [
        "locate/locate",
        "find/version",
    ],
    "frcode": [
        "locate/frcode",
        "find/version",
    ],
    "code": [
        "locate/code",
        "find/version",
    ],
    "bigram": [
        "locate/bigram",
        "find/version",
    ],
}

PROGRAM_SOURCES = [
    "find/find",
    "find/fstype",
    "find/parser",
    "find/pred",
    "find/tree",
    "find/util",
    "find/version",
    "locate/bigram",
    "locate/code",
    "locate/frcode",
    "locate/locate",
    "xargs/xargs",
]

FIND_LIB = [
    "gnulib-version",
    "listfile",
    "nextelem",
    "extendbuf",
    "buildcmd",
    "savedirinfo",
    "forcefindlib",
    "qmark",
    "printquoted",
    "regextype",
]

GNU_LIB = [
    "dirname",
    "areadlink-with-size",
    "argmatch",
    "basename",
    "canonicalize",
    "chdir-long",
    "close-stream",
    "closein",
    "closeout",
    "dup-safer",
    "error",
    "exitfail",
    "fd-safer",
    "file-set",
    "filemode",
    "filenamecat",
    "fopen-safer",
    "fpurge",
    "getopt",
    "getopt1",
    "hash",
    "hash-pjw",
    "hash-triple",
    "human",
    "idcache",
    "localcharset",
    "malloca",
    "modechange",
    "mountlist",
    "open-safer",
    "openat-die",
    "openat-proc",
    "pipe-safer",
    "progname",
    "quote",
    "quotearg",
    "regex",
    "same",
    "save-cwd",
    "savedir",
    "strftime",
    "stripslash",
    "xalloc-die",
    "xgetcwd",
    "xmalloc",
    "xstrndup",
    "xstrtol",
    "xstrtol-error",
    "xstrtoul",
    "xstrtoumax",
    "yesno",
]

HEADERS = [
    "find/defs.h",
    "gnulib/lib/alloca.in.h",
    "gnulib/lib/areadlink.h",
    "gnulib/lib/argmatch.h",
    "gnulib/lib/binary-io.h",
    "gnulib/lib/canonicalize.h",
    "gnulib/lib/chdir-long.h",
    "gnulib/lib/close-stream.h",
    "gnulib/lib/closein.h",
    "gnulib/lib/closeout.h",
    "gnulib/lib/dirent.in.h",
    "gnulib/lib/dirfd.h",
    "gnulib/lib/dirname.h",
    "gnulib/lib/error.h",
    "gnulib/lib/exitfail.h",
    "gnulib/lib/fcntl--.h",
    "gnulib/lib/fcntl-safer.h",
    "gnulib/lib/fcntl.in.h",
    "gnulib/lib/file-set.h",
    "gnulib/lib/filemode.h",
    "gnulib/lib/filenamecat.h",
    "gnulib/lib/fnmatch.in.h",
    "gnulib/lib/fpending.h",
    "gnulib/lib/fpurge.h",
    "gnulib/lib/freadahead.h",
    "gnulib/lib/freading.h",
    "gnulib/lib/getopt.in.h",
    "gnulib/lib/getopt_int.h",
    "gnulib/lib/gettext.h",
    "gnulib/lib/hash-pjw.h",
    "gnulib/lib/hash-triple.h",
    "gnulib/lib/hash.h",
    "gnulib/lib/human.h",
    "gnulib/lib/idcache.h",
    "gnulib/lib/intprops.h",
    "gnulib/lib/inttypes.in.h",
    "gnulib/lib/localcharset.h",
    "gnulib/lib/lstat.h",
    "gnulib/lib/malloca.h",
    "gnulib/lib/modechange.h",
    "gnulib/lib/mountlist.h",
    "gnulib/lib/openat-priv.h",
    "gnulib/lib/openat.h",
    "gnulib/lib/pathmax.h",
    "gnulib/lib/progname.h",
    "gnulib/lib/quote.h",
    "gnulib/lib/quotearg.h",
    "gnulib/lib/regex.h",
    "gnulib/lib/regex_internal.h",
    "gnulib/lib/same-inode.h",
    "gnulib/lib/same.h",
    "gnulib/lib/save-cwd.h",
    "gnulib/lib/savedir.h",
    "gnulib/lib/stat-macros.h",
    "gnulib/lib/stdbool.in.h",
    "gnulib/lib/stdint.in.h",
    "gnulib/lib/stdio--.h",
    "gnulib/lib/stdio-safer.h",
    "gnulib/lib/stdio.in.h",
    "gnulib/lib/stdlib.in.h",
    "gnulib/lib/strftime.h",
    "gnulib/lib/string.in.h",
    "gnulib/lib/sys_stat.in.h",
    "gnulib/lib/time.in.h",
    "gnulib/lib/unistd--.h",
    "gnulib/lib/unistd-safer.h",
    "gnulib/lib/unistd.in.h",
    "gnulib/lib/verify.h",
    "gnulib/lib/wchar.in.h",
    "gnulib/lib/wctype.in.h",
    "gnulib/lib/xalloc.h",
    "gnulib/lib/xgetcwd.h",
    "gnulib/lib/xstrndup.h",
    "gnulib/lib/xstrtol.h",
    "gnulib/lib/yesno.h",
    "lib/buildcmd.h",
    "lib/extendbuf.h",
    "lib/gnulib-version.h",
    "lib/listfile.h",
    "lib/modetype.h",
    "lib/nextelem.h",
    "lib/printquoted.h",
    "lib/regextype.h",
    "lib/savedirinfo.h",
    "lib/wait.h",
    "locate/locatedb.h",
]

FILES = [n + ".c" for n in PROGRAM_SOURCES] + ["lib/" + n + ".c" for n in FIND_LIB if n != "gnulib-version"] + ["gnulib/lib/" + n + ".c" for n in GNU_LIB] + HEADERS + [
    "gnulib/lib/regcomp.c",
    "gnulib/lib/regexec.c",
    "gnulib/lib/regex_internal.c",
    "gnulib/lib/at-func.c",
    "gnulib/lib/getopt.in.h",
    "gnulib/lib/sys_stat.in.h",
    "gnulib/lib/fcntl.in.h",
    "locate/updatedb.sh",
    "COPYING",
]

CONFIG_ON = [
    "D_INO_IN_DIRENT",
    "FINDUTILS",
    "GNULIB_CANONICALIZE",
    "GNULIB_CLOSE_STREAM",
    "GNULIB_FCNTL_SAFER",
    "GNULIB_FOPEN_SAFER",
    "HAVE_ALARM",
    "HAVE_ALLOCA",
    "HAVE_ALLOCA_H",
    "HAVE_BTOWC",
    "HAVE_CHOWN",
    "HAVE_DECL_DIRFD",
    "HAVE_DECL_GETCWD",
    "HAVE_DECL_GETC_UNLOCKED",
    "HAVE_DECL_GETDELIM",
    "HAVE_DECL_GETENV",
    "HAVE_DECL_GETLINE",
    "HAVE_DECL_IMAXABS",
    "HAVE_DECL_IMAXDIV",
    "HAVE_DECL_ISBLANK",
    "HAVE_DECL_MEMRCHR",
    "HAVE_DECL_MKDIR",
    "HAVE_DECL_STRDUP",
    "HAVE_DECL_STRERROR",
    "HAVE_DECL_STRERROR_R",
    "HAVE_DECL_STRNDUP",
    "HAVE_DECL_STRNLEN",
    "HAVE_DECL_STRTOIMAX",
    "HAVE_DECL_STRTOLL",
    "HAVE_DECL_STRTOULL",
    "HAVE_DECL_STRTOUMAX",
    "HAVE_DECL_TZNAME",
    "HAVE_DECL___FPENDING",
    "HAVE_DIRENT_H",
    "HAVE_DIRFD",
    "HAVE_DUP2",
    "HAVE_ENDGRENT",
    "HAVE_ENDMNTENT",
    "HAVE_ENDPWENT",
    "HAVE_ERRNO_H",
    "HAVE_FCHDIR",
    "HAVE_FCHMODAT",
    "HAVE_FCNTL_H",
    "HAVE_FDOPENDIR",
    "HAVE_FLOCKFILE",
    "HAVE_FSEEKO",
    "HAVE_FUNLOCKFILE",
    "HAVE_GETCWD",
    "HAVE_GETDELIM",
    "HAVE_GETMNTENT",
    "HAVE_GETOPT_H",
    "HAVE_GETOPT_LONG_ONLY",
    "HAVE_GETPAGESIZE",
    "HAVE_HASMNTOPT",
    "HAVE_ICONV",
    "HAVE_INCLUDE_NEXT",
    "HAVE_INLINE",
    "HAVE_INTTYPES_H",
    "HAVE_ISBLANK",
    "HAVE_ISWCNTRL",
    "HAVE_ISWCTYPE",
    "HAVE_LANGINFO_CODESET",
    "HAVE_LCHMOD",
    "HAVE_LCHOWN",
    "HAVE_LIMITS_H",
    "HAVE_LOCALE_H",
    "HAVE_LONG_FILE_NAMES",
    "HAVE_LONG_LONG_INT",
    "HAVE_LSTAT",
    "HAVE_MALLOC",
    "HAVE_MALLOC_POSIX",
    "HAVE_MBLEN",
    "HAVE_MBRLEN",
    "HAVE_MBRTOWC",
    "HAVE_MBSINIT",
    "HAVE_MBSRTOWCS",
    "HAVE_MBSTATE_T",
    "HAVE_MEMCMP",
    "HAVE_MEMORY_H",
    "HAVE_MEMPCPY",
    "HAVE_MEMRCHR",
    "HAVE_MEMSET",
    "HAVE_MKDIRAT",
    "HAVE_MNTENT_H",
    "HAVE_OPENAT",
    "HAVE_PATHCONF",
    "HAVE_PIPE",
    "HAVE_READLINK",
    "HAVE_REALLOC",
    "HAVE_REALLOC_POSIX",
    "HAVE_RPMATCH",
    "HAVE_SETLOCALE",
    "HAVE_SETMNTENT",
    "HAVE_SIGNED_SIG_ATOMIC_T",
    "HAVE_SIGNED_WCHAR_T",
    "HAVE_STDBOOL_H",
    "HAVE_STDDEF_H",
    "HAVE_STDINT_H",
    "HAVE_STDIO_EXT_H",
    "HAVE_STDIO_H",
    "HAVE_STDLIB_H",
    "HAVE_STPCPY",
    "HAVE_STRDUP",
    "HAVE_STRERROR",
    "HAVE_STRERROR_R",
    "HAVE_STRFTIME",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_STRNDUP",
    "HAVE_STRSPN",
    "HAVE_STRSTR",
    "HAVE_STRTOIMAX",
    "HAVE_STRTOL",
    "HAVE_STRTOLL",
    "HAVE_STRTOUL",
    "HAVE_STRTOULL",
    "HAVE_STRTOUMAX",
    "HAVE_STRUCT_DIRENT_D_TYPE",
    "HAVE_STRUCT_STAT_ST_BLOCKS",
    "HAVE_STRUCT_STAT_ST_RDEV",
    "HAVE_STRUCT_TM_TM_ZONE",
    "HAVE_ST_BLOCKS",
    "HAVE_SYS_MOUNT_H",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_STATVFS_H",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_TIME_H",
    "HAVE_SYS_TYPES_H",
    "HAVE_SYS_UTSNAME_H",
    "HAVE_SYS_WAIT_H",
    "HAVE_TIME_H",
    "HAVE_TM_GMTOFF",
    "HAVE_TM_ZONE",
    "HAVE_TZNAME",
    "HAVE_TZSET",
    "HAVE_UNISTD_H",
    "HAVE_UNSIGNED_LONG_LONG_INT",
    "HAVE_VPRINTF",
    "HAVE_WAITPID",
    "HAVE_WCHAR_H",
    "HAVE_WCHAR_T",
    "HAVE_WCRTOMB",
    "HAVE_WCSCOLL",
    "HAVE_WCTYPE_H",
    "HAVE_WINT_T",
    "HAVE_WMEMCHR",
    "HAVE_WMEMCPY",
    "HAVE_WMEMPCPY",
    "HAVE_WORKING_O_NOATIME",
    "HAVE_WORKING_O_NOFOLLOW",
    "HAVE__BOOL",
    "HAVE___FPENDING",
    "HAVE___FPURGE",
    "HAVE___FREADING",
    "LEAF_OPTIMISATION",
    "LSTAT_FOLLOWS_SLASHED_SYMLINK",
    "MAJOR_IN_SYSMACROS",
    "MOUNTED_GETMNTENT1",
    "PROTOTYPES",
    "STDC_HEADERS",
    "USE_STRUCT_DIRENT_D_TYPE",
]

CONFIG_VALUES = {
    "_GNU_SOURCE": "1",
    "FLEXIBLE_ARRAY_MEMBER": "",
    "restrict": "__restrict",
    "_GL_UNUSED": "__attribute__((__unused__))",
    "O_BINARY": "0",
    "O_TEXT": "0",
    "__GETOPT_PREFIX": "rpl_",
    "my_strftime": "nstrftime",
    "freadahead": "__freadahead",
    "PACKAGE": "\"findutils\"",
    "PACKAGE_NAME": "\"GNU findutils\"",
    "PACKAGE_VERSION": "\"4.2.33\"",
    "PACKAGE_STRING": "\"GNU findutils 4.2.33\"",
    "PACKAGE_BUGREPORT": "\"bug-findutils@gnu.org\"",
    "VERSION": "\"4.2.33\"",
    "LOCALEDIR": "\"/bootstrap/share/locale\"",
    "LOCATE_DB": "\"/bootstrap/var/locatedb\"",
    "LIBDIR": "\"/bootstrap/lib\"",
}

write_file(
    name = "config.h",
    content = "\n".join(["#define " + n + " 1" for n in CONFIG_ON]) + "\n" + "\n".join(["#define " + n + " " + v for n, v in CONFIG_VALUES.items()]) + "\n",
)

# Build metadata is configuration, not release-generated parser code.
write_file(
    name = "gnulib-version.c",
    content = 'const char * const gnulib_version = "8e128ebf42e16c8631f971a68f188c30962818be";\n',
)

download_file(
    name = "findutils-4.2.33.tar.gz",
    hash = "813cd9405aceec5cfecbe96400d01e90ddad7b512d3034487176ce5258ab0f78",
    urls = ["https://mirrors.kernel.org/gnu/findutils/findutils-4.2.33.tar.gz"],
)

generate(
    name = "findutils.tar",
    args = [
        "-dc",
        "$(location :findutils-4.2.33.tar.gz)",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/gzip:gzip",
)

untar(
    name = "findutils-4.2.33",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    flags = [
        "--numeric-owner",
        "-xf",
    ],
    input = ":findutils.tar",
    untar = "cellar//bootstrap/stage1/tar-final:tar",
)

HEADER_CONFIG = {
    "sys/stat.h": (
        "sys_stat",
        {
            "INCLUDE_NEXT": "include_next",
            "NEXT_SYS_STAT_H": "<sys/stat.h>",
            "HAVE_LSTAT": "1",
            "HAVE_DECL_MKDIR": "1",
            "HAVE_IO_H": "0",
        },
    ),
    "fcntl.h": (
        "fcntl",
        {
            "INCLUDE_NEXT": "include_next",
            "NEXT_FCNTL_H": "<fcntl.h>",
            "GNULIB_OPEN": "0",
            "REPLACE_OPEN": "0",
        },
    ),
}

[generate(
    name = "header-" + name.replace("/", "-"),
    args = [a for k, v in values.items() for a in [
        "-e",
        "s|@" + k + "@|" + v + "|g",
    ]] + ["$(location :findutils-4.2.33[gnulib/lib/" + template + ".in.h])"],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/sed-final:sed",
) for name, (template, values) in HEADER_CONFIG.items()]

# Default xargs echo follows the explicitly supplied PATH.
exact_patch(
    name = "xargs.c",
    src = ":findutils-4.2.33[xargs/xargs.c]",
    after = 'char *default_cmd = "echo";',
    before = 'char *default_cmd = "/bin/echo";',
)

filegroup(
    name = "source",
    srcs = {p: ":findutils-4.2.33[" + p + "]" for p in FILES if p != "xargs/xargs.c"} | {
        "config.h": ":config.h",
        "lib/gnulib-version.c": ":gnulib-version.c",
        "xargs/xargs.c": ":xargs.c",
        "gnulib/lib/getopt.h": ":findutils-4.2.33[gnulib/lib/getopt.in.h]",
    } | {"gnulib/lib/" + n: ":header-" + n.replace("/", "-") for n in HEADER_CONFIG},
)

INCLUDES = [
    ".",
    "lib",
    "gnulib/lib",
    "find",
    "locate",
]

ALL_SOURCES = PROGRAM_SOURCES + ["lib/" + n for n in FIND_LIB] + ["gnulib/lib/" + n for n in GNU_LIB]

[c_object(
    name = path.replace("/", "-") + ".o",
    src = ":source[" + path + ".c]",
    defines = ["HAVE_CONFIG_H=1"],
    flags = [
        "-O2",
        "-Werror=implicit-function-declaration",
    ] + ([
        "-include",
        "unistd.h",
    ] if path == "gnulib/lib/openat-proc" else []),
    logical_includes = INCLUDES,
    logical_source = path + ".c",
    object_name = "fi" + str(i) + ".o",
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":source",
    toolchain = CC,
) for i, path in enumerate(ALL_SOURCES)]

[c_library(
    name = name + ".a",
    objects = [":" + prefix + n + ".o" for n in sources],
    output = name + ".a",
    toolchain = CC,
) for name, prefix, sources in [
    ("libfind", "lib-", FIND_LIB),
    ("libgnulib", "gnulib-lib-", GNU_LIB),
]]

[c_binary(
    name = name + "-bin",
    end_objects = CRTN,
    libraries = [
        ":libfind.a",
        ":libgnulib.a",
    ] + LIBC,
    objects = CRT + [":" + n.replace("/", "-") + ".o" for n in sources],
    output = name,
    toolchain = CC,
) for name, sources in PROGRAMS.items()]

[configured_tool(
    name = n,
    env = {"PATH": "$(location cellar//bootstrap/stage1/coreutils-final:installation[bin])"},
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = ":" + n + "-bin",
) for n in PROGRAMS]

filegroup(
    name = "installation",
    srcs = {("bin/" if n in [
        "find",
        "xargs",
        "locate",
    ] else "libexec/") + n: ":" + n + "-bin" for n in PROGRAMS} | {
        "bin/updatedb": ":updatedb-script",
        "share/licenses/findutils/COPYING": ":source[COPYING]",
    },
)

[command_test(
    name = n + "-version",
    args = ["--version"],
    tool = ":" + n,
) for n in [
    "find",
    "xargs",
    "locate",
]]

# The upstream script composes individual delivered programs. It is not used
# to build this package. Keep its PATH inside the caller's declared tool set.
generate(
    name = "updatedb-text",
    args = [
        "-e",
        "s|@bindir@|/bootstrap/bin|g",
        "-e",
        "s|@libexecdir@|/bootstrap/libexec|g",
        "-e",
        "s|@LOCATE_DB@|/bootstrap/var/locatedb|g",
        "-e",
        "s|@VERSION@|4.2.33|g",
        "-e",
        "s|@SORT@|sort|g",
        "-e",
        "s|@SORT_SUPPORTS_Z@|true|g",
        "-e",
        "s|@find@|find|g",
        "-e",
        "s|@frcode@|frcode|g",
        "-e",
        "s|@code@|code|g",
        "-e",
        "s|@bigram@|bigram|g",
        "-e",
        "s|PATH=/bin:/usr/bin:${BINDIR}|PATH=${BINDIR}:$PATH|",
        # Quote every tool, database and temporary path so an installation
        # or TMPDIR containing spaces still works. The su command strings
        # keep upstream's form, since the installation delivers no su.
        "-e",
        "s|^    \\$find |    \"$find\" |",
        "-e",
        "s|\\$frcode \\$frcode_options|\"$frcode\" $frcode_options|",
        "-e",
        "s|^\\$bigram \\$bigram_opts < \\$filelist|\"$bigram\" $bigram_opts < \"$filelist\"|",
        "-e",
        "s|^\\$code \\$bigrams < \\$filelist|\"$code\" \"$bigrams\" < \"$filelist\"|",
        "-e",
        "s|> \\$bigrams$|> \"$bigrams\"|",
        "-e",
        "s|> \\$filelist$|> \"$filelist\"|",
        "-e",
        "s|rm -f \\$bigrams \\$filelist|rm -f \"$bigrams\" \"$filelist\"|",
        "-e",
        "s|\\$LOCATE_DB\\.n|\"$LOCATE_DB.n\"|g",
        "-e",
        "s|generate \"\\$LOCATE_DB\\.n\"\"|generate $LOCATE_DB.n\"|",
        "-e",
        "s|\\$LOCATE_DB$|\"$LOCATE_DB\"|",
        "$(location :source[locate/updatedb.sh])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/sed-final:sed",
)

generate(
    name = "updatedb-script",
    args = [
        "-m",
        "755",
        "$(location :updatedb-text)",
    ],
    tool = "cellar//bootstrap/stage1/coreutils-final:install",
)

filegroup(
    name = "script-tools",
    srcs = {"bin/" + n: "cellar//bootstrap/stage1/coreutils-final:" + n for n in [
        "sort",
        "tr",
        "cut",
        "id",
        "rm",
        "mv",
        "chmod",
        "uniq",
    ]} | {
        "bin/sed": "cellar//bootstrap/stage1/sed-final:sed",
        "bin/awk": "cellar//bootstrap/stage1/gawk-final:gawk-bin",
    },
)

configured_tool(
    name = "updatedb",
    args = [
        "--noprofile",
        "--norc",
        "$(location :updatedb-script)",
    ],
    env = {
        "BINDIR": "$(location :installation[bin])",
        "LIBEXECDIR": "$(location :installation[libexec])",
        "PATH": "$(location :script-tools[bin])",
        "CELLAR_BOOTSTRAP_IDENTITY": "1",
    },
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = "cellar//bootstrap/stage1/bash:bash",
)

command_test(
    name = "updatedb-version",
    args = ["--version"],
    tool = ":updatedb",
)

filegroup(
    name = "test-source",
    srcs = {n + ".sh": "tests/" + n + ".sh" for n in [
        "find",
        "xargs",
        "locate",
    ]},
)

write_file(
    name = "passed",
    content = "passed\n",
)

[
    [
        generate(
            name = name + "-output",
            args = [
                "--noprofile",
                "--norc",
                "source/" + name + ".sh",
                "$(location :installation)",
                "$(location cellar//bootstrap/stage1/coreutils-final:installation[bin])",
                "$(location :script-tools[bin])",
                "$(exe cellar//bootstrap/stage1/bash:bash)",
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
        ),
        command_test(
            name = name + "-semantics",
            args = [
                "$(location :" + name + "-output[passed])",
                "$(location :passed)",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        ),
    ]
    for name in [
        "find",
        "xargs",
        "locate",
    ]
]
