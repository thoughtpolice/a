# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")
load(":sources.bzl", "HEADERS")

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

CORE = [
    "shell.c",
    "eval.c",
    "general.c",
    "make_cmd.c",
    "print_cmd.c",
    "dispose_cmd.c",
    "execute_cmd.c",
    "variables.c",
    "copy_cmd.c",
    "error.c",
    "expr.c",
    "flags.c",
    "jobs.c",
    "subst.c",
    "hashcmd.c",
    "hashlib.c",
    "mailcheck.c",
    "trap.c",
    "input.c",
    "unwind_prot.c",
    "pathexp.c",
    "sig.c",
    "test.c",
    "version.c",
    "alias.c",
    "array.c",
    "arrayfunc.c",
    "assoc.c",
    "braces.c",
    "bracecomp.c",
    "bashhist.c",
    "bashline.c",
    "list.c",
    "stringlib.c",
    "locale.c",
    "findcmd.c",
    "redir.c",
    "pcomplete.c",
    "pcomplib.c",
    "xmalloc.c",
    "siglist.c",
]

SH = [
    "lib/sh/clktck.c",
    "lib/sh/clock.c",
    "lib/sh/getenv.c",
    "lib/sh/oslib.c",
    "lib/sh/setlinebuf.c",
    "lib/sh/strnlen.c",
    "lib/sh/itos.c",
    "lib/sh/zread.c",
    "lib/sh/zwrite.c",
    "lib/sh/shtty.c",
    "lib/sh/shmatch.c",
    "lib/sh/eaccess.c",
    "lib/sh/netconn.c",
    "lib/sh/netopen.c",
    "lib/sh/timeval.c",
    "lib/sh/makepath.c",
    "lib/sh/pathcanon.c",
    "lib/sh/pathphys.c",
    "lib/sh/tmpfile.c",
    "lib/sh/stringlist.c",
    "lib/sh/stringvec.c",
    "lib/sh/spell.c",
    "lib/sh/shquote.c",
    "lib/sh/strtrans.c",
    "lib/sh/snprintf.c",
    "lib/sh/mailstat.c",
    "lib/sh/fmtulong.c",
    "lib/sh/fmtullong.c",
    "lib/sh/fmtumax.c",
    "lib/sh/zcatfd.c",
    "lib/sh/zmapfd.c",
    "lib/sh/winsize.c",
    "lib/sh/wcsdup.c",
    "lib/sh/fpurge.c",
    "lib/sh/zgetline.c",
    "lib/sh/mbscmp.c",
    "lib/sh/uconvert.c",
    "lib/sh/ufuncs.c",
    "lib/sh/casemod.c",
    "lib/sh/input_avail.c",
    "lib/sh/mbscasecmp.c",
    "lib/sh/fnxform.c",
    "lib/sh/unicode.c",
    "lib/sh/shmbchar.c",
    "lib/sh/strvis.c",
    "lib/sh/utf8.c",
    "lib/sh/random.c",
    "lib/sh/gettimeofday.c",
    "lib/sh/timers.c",
    "lib/sh/wcsnwidth.c",
    "lib/sh/mbschr.c",
]

READLINE_SOURCES = [
    "lib/readline/readline.c",
    "lib/readline/vi_mode.c",
    "lib/readline/funmap.c",
    "lib/readline/keymaps.c",
    "lib/readline/parens.c",
    "lib/readline/search.c",
    "lib/readline/rltty.c",
    "lib/readline/complete.c",
    "lib/readline/bind.c",
    "lib/readline/isearch.c",
    "lib/readline/display.c",
    "lib/readline/signals.c",
    "lib/readline/util.c",
    "lib/readline/kill.c",
    "lib/readline/undo.c",
    "lib/readline/macro.c",
    "lib/readline/input.c",
    "lib/readline/callback.c",
    "lib/readline/terminal.c",
    "lib/readline/text.c",
    "lib/readline/nls.c",
    "lib/readline/misc.c",
    "lib/readline/history.c",
    "lib/readline/histexpand.c",
    "lib/readline/histfile.c",
    "lib/readline/histsearch.c",
    "lib/readline/shell.c",
    "lib/readline/savestring.c",
    "lib/readline/mbutil.c",
    "lib/readline/tilde.c",
    "lib/readline/colors.c",
    "lib/readline/parse-colors.c",
    "lib/readline/xmalloc.c",
    "lib/readline/xfree.c",
    "lib/readline/compat.c",
]

BUILTINS = [
    "alias",
    "bind",
    "break",
    "builtin",
    "caller",
    "cd",
    "colon",
    "command",
    "complete",
    "declare",
    "echo",
    "enable",
    "eval",
    "exec",
    "exit",
    "fc",
    "fg_bg",
    "hash",
    "help",
    "history",
    "jobs",
    "kill",
    "let",
    "read",
    "return",
    "set",
    "setattr",
    "shift",
    "source",
    "suspend",
    "test",
    "times",
    "trap",
    "type",
    "ulimit",
    "umask",
    "wait",
    "getopts",
    "pushd",
    "shopt",
    "printf",
    "mapfile",
]

GLOB = ["lib/glob/" + name + ".c" for name in [
    "glob",
    "strmatch",
    "smatch",
    "xmbsrtowcs",
    "gmisc",
]]

TERMCAP = [
    "lib/termcap/termcap.c",
    "lib/termcap/tparam.c",
]

BUILTIN_STATIC = ["builtins/" + name + ".c" for name in [
    "common",
    "evalstring",
    "evalfile",
    "getopt",
    "bashgetopt",
]]

DEFINITIONS = ["builtins/" + name + ".def" for name in BUILTINS + ["reserved"]]

GENERATORS = {
    "mkbuiltins": ["builtins/mkbuiltins.c"],
    "mksyntax": ["mksyntax.c"],
    "mksignames": [
        "support/mksignames.c",
        "support/signames.c",
    ],
}

FILES = CORE + SH + READLINE_SOURCES + GLOB + TERMCAP + BUILTIN_STATIC + DEFINITIONS + HEADERS + [path for paths in GENERATORS.values() for path in paths] + [
    "lib/glob/glob_loop.c",
    "lib/glob/gm_loop.c",
    "lib/glob/sm_loop.c",
    "lib/readline/emacs_keymap.c",
    "lib/readline/vi_keymap.c",
    "COPYING",
    "parse.y",
    "pathnames.h.in",
]

# Reviewed Linux x86_64 / musl configuration. Keep the normal shell features,
# bundled Readline/termcap and native job control; use musl's allocator.
FEATURES = [
    "JOB_CONTROL",
    "ALIAS",
    "PUSHD_AND_POPD",
    "BRACE_EXPANSION",
    "HELP_BUILTIN",
    "DISABLED_BUILTINS",
    "PROCESS_SUBSTITUTION",
    "PROMPT_STRING_DECODE",
    "SELECT_COMMAND",
    "COMMAND_TIMING",
    "ARRAY_VARS",
    "DPAREN_ARITHMETIC",
    "EXTENDED_GLOB",
    "COND_COMMAND",
    "ARITH_FOR_COMMAND",
    "READLINE",
    "BANG_HISTORY",
    "HISTORY",
    "RESTRICTED_SHELL",
    "NETWORK_REDIRECTIONS",
    "PROGRAMMABLE_COMPLETION",
    "CASEMOD_ATTRS",
    "CASEMOD_EXPANSIONS",
    "GLOBASCII_DEFAULT",
    "FUNCTION_IMPORT",
    "BRACE_COMPLETION",
    "COND_REGEXP",
    "COPROCESS_SUPPORT",
]

CONFIG_ON = [
    "FIONREAD_IN_SYS_IOCTL",
    "GETPGRP_VOID",
    "GWINSZ_IN_SYS_IOCTL",
    "HAVE_ALLOCA",
    "HAVE_ALLOCA_H",
    "HAVE_ARPA_INET_H",
    "HAVE_ASPRINTF",
    "HAVE_BCOPY",
    "HAVE_BZERO",
    "HAVE_CHOWN",
    "HAVE_CONFSTR",
    "HAVE_DECL_CONFSTR",
    "HAVE_DECL_PRINTF",
    "HAVE_DECL_SBRK",
    "HAVE_DECL_SETREGID",
    "HAVE_DECL_SETRESGID",
    "HAVE_DECL_SETRESUID",
    "HAVE_DECL_STRCPY",
    "HAVE_DECL_STRSIGNAL",
    "HAVE_DECL_STRTOIMAX",
    "HAVE_DECL_STRTOL",
    "HAVE_DECL_STRTOLD",
    "HAVE_DECL_STRTOLL",
    "HAVE_DECL_STRTOUL",
    "HAVE_DECL_STRTOULL",
    "HAVE_DECL_STRTOUMAX",
    "HAVE_DECL_TZNAME",
    "HAVE_DEV_FD",
    "HAVE_DEV_STDIN",
    "HAVE_DIRENT_H",
    "HAVE_DLFCN_H",
    "HAVE_DPRINTF",
    "HAVE_DUP2",
    "HAVE_ERRNO_H",
    "HAVE_FACCESSAT",
    "HAVE_FCNTL",
    "HAVE_FCNTL_H",
    "HAVE_FNMATCH",
    "HAVE_GETADDRINFO",
    "HAVE_GETCWD",
    "HAVE_GETDTABLESIZE",
    "HAVE_GETENTROPY",
    "HAVE_GETGROUPS",
    "HAVE_GETHOSTBYNAME",
    "HAVE_GETHOSTNAME",
    "HAVE_GETPAGESIZE",
    "HAVE_GETPEERNAME",
    "HAVE_GETPWENT",
    "HAVE_GETPWNAM",
    "HAVE_GETPWUID",
    "HAVE_GETPW_DECLS",
    "HAVE_GETRANDOM",
    "HAVE_GETRLIMIT",
    "HAVE_GETRUSAGE",
    "HAVE_GETSERVBYNAME",
    "HAVE_GETSERVENT",
    "HAVE_GETTIMEOFDAY",
    "HAVE_GRP_H",
    "HAVE_HASH_BANG_EXEC",
    "HAVE_ICONV",
    "HAVE_IMAXDIV",
    "HAVE_INET_ATON",
    "HAVE_INTTYPES_H",
    "HAVE_ISASCII",
    "HAVE_ISBLANK",
    "HAVE_ISGRAPH",
    "HAVE_ISPRINT",
    "HAVE_ISSPACE",
    "HAVE_ISWCTYPE",
    "HAVE_ISWLOWER",
    "HAVE_ISWUPPER",
    "HAVE_ISXDIGIT",
    "HAVE_KILL",
    "HAVE_KILLPG",
    "HAVE_LANGINFO_CODESET",
    "HAVE_LANGINFO_H",
    "HAVE_LIMITS_H",
    "HAVE_LOCALECONV",
    "HAVE_LOCALE_H",
    "HAVE_LONG_DOUBLE",
    "HAVE_LONG_LONG_INT",
    "HAVE_LSTAT",
    "HAVE_MALLOC_H",
    "HAVE_MBRLEN",
    "HAVE_MBRTOWC",
    "HAVE_MBSNRTOWCS",
    "HAVE_MBSRTOWCS",
    "HAVE_MBSTATE_T",
    "HAVE_MEMMOVE",
    "HAVE_MEMORY_H",
    "HAVE_MEMPCPY",
    "HAVE_MEMSET",
    "HAVE_MKDTEMP",
    "HAVE_MKFIFO",
    "HAVE_MKSTEMP",
    "HAVE_MMAP",
    "HAVE_MREMAP",
    "HAVE_MUNMAP",
    "HAVE_NETDB_H",
    "HAVE_NETINET_IN_H",
    "HAVE_NL_LANGINFO",
    "HAVE_PATHCONF",
    "HAVE_POSIX_SIGNALS",
    "HAVE_POSIX_SIGSETJMP",
    "HAVE_PRINTF_A_FORMAT",
    "HAVE_PSELECT",
    "HAVE_PUTENV",
    "HAVE_PWD_H",
    "HAVE_RAISE",
    "HAVE_RANDOM",
    "HAVE_READLINK",
    "HAVE_REGCOMP",
    "HAVE_REGEXEC",
    "HAVE_REGEX_H",
    "HAVE_RENAME",
    "HAVE_SBRK",
    "HAVE_SELECT",
    "HAVE_SETENV",
    "HAVE_SETITIMER",
    "HAVE_SETLINEBUF",
    "HAVE_SETLOCALE",
    "HAVE_SETREGID",
    "HAVE_SETRESGID",
    "HAVE_SETRESUID",
    "HAVE_SETVBUF",
    "HAVE_SIGINTERRUPT",
    "HAVE_SNPRINTF",
    "HAVE_STDARG_H",
    "HAVE_STDBOOL_H",
    "HAVE_STDDEF_H",
    "HAVE_STDINT_H",
    "HAVE_STDIO_EXT_H",
    "HAVE_STDLIB_H",
    "HAVE_STD_PUTENV",
    "HAVE_STD_UNSETENV",
    "HAVE_STPCPY",
    "HAVE_STRCASECMP",
    "HAVE_STRCASESTR",
    "HAVE_STRCHR",
    "HAVE_STRCHRNUL",
    "HAVE_STRCOLL",
    "HAVE_STRCSPN",
    "HAVE_STRDUP",
    "HAVE_STRERROR",
    "HAVE_STRFTIME",
    "HAVE_STRINGIZE",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_STRNLEN",
    "HAVE_STRPBRK",
    "HAVE_STRSIGNAL",
    "HAVE_STRSTR",
    "HAVE_STRTOD",
    "HAVE_STRTOIMAX",
    "HAVE_STRTOL",
    "HAVE_STRTOLL",
    "HAVE_STRTOUL",
    "HAVE_STRTOULL",
    "HAVE_STRTOUMAX",
    "HAVE_STRUCT_DIRENT_D_INO",
    "HAVE_STRUCT_STAT_ST_ATIM_TV_NSEC",
    "HAVE_STRUCT_STAT_ST_BLOCKS",
    "HAVE_STRUCT_TIMESPEC",
    "HAVE_STRUCT_TIMEZONE",
    "HAVE_STRUCT_TM_TM_ZONE",
    "HAVE_SYSCONF",
    "HAVE_SYSLOG",
    "HAVE_SYSLOG_H",
    "HAVE_SYS_FILE_H",
    "HAVE_SYS_IOCTL_H",
    "HAVE_SYS_MMAN_H",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_RANDOM_H",
    "HAVE_SYS_RESOURCE_H",
    "HAVE_SYS_SELECT_H",
    "HAVE_SYS_SOCKET_H",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_TIMES_H",
    "HAVE_SYS_TIME_H",
    "HAVE_SYS_TYPES_H",
    "HAVE_SYS_WAIT_H",
    "HAVE_TCGETATTR",
    "HAVE_TCGETPGRP",
    "HAVE_TERMIOS_H",
    "HAVE_TERMIO_H",
    "HAVE_TIMES",
    "HAVE_TIMEVAL",
    "HAVE_TM_ZONE",
    "HAVE_TOWLOWER",
    "HAVE_TOWUPPER",
    "HAVE_TTYNAME",
    "HAVE_TZNAME",
    "HAVE_TZSET",
    "HAVE_ULIMIT",
    "HAVE_ULIMIT_H",
    "HAVE_UNAME",
    "HAVE_UNISTD_H",
    "HAVE_UNSETENV",
    "HAVE_UNSIGNED_LONG_LONG_INT",
    "HAVE_VASPRINTF",
    "HAVE_VPRINTF",
    "HAVE_VSNPRINTF",
    "HAVE_WAIT3",
    "HAVE_WAITPID",
    "HAVE_WCHAR_H",
    "HAVE_WCHAR_T",
    "HAVE_WCRTOMB",
    "HAVE_WCSCOLL",
    "HAVE_WCSDUP",
    "HAVE_WCSWIDTH",
    "HAVE_WCTYPE",
    "HAVE_WCTYPE_H",
    "HAVE_WCTYPE_T",
    "HAVE_WCWIDTH",
    "HAVE_WINT_T",
    "HAVE___FPURGE",
    "PROTOTYPES",
    "STRUCT_WINSIZE_IN_SYS_IOCTL",
    "TIME_H_DEFINES_STRUCT_TIMESPEC",
    "TYPEOF_STRUCT_STAT_ST_ATIM_IS_STRUCT_TIMESPEC",
]

CONFIG_VALUES = {
    "_GNU_SOURCE": "1",
    "SIZEOF_INT": "4",
    "SIZEOF_LONG": "8",
    "SIZEOF_CHAR_P": "8",
    "SIZEOF_DOUBLE": "8",
    "SIZEOF_LONG_LONG": "8",
    "GETGROUPS_T": "gid_t",
    "RLIMTYPE": "rlim_t",
    "STACK_DIRECTION": "-1",
    "RETSIGTYPE": "void",
    "DEV_FD_PREFIX": "\"/dev/fd/\"",
    "DEFAULT_PATH_VALUE": "\"/bootstrap/bin\"",
    "STANDARD_UTILS_PATH": "\"/bootstrap/bin\"",
    "CONF_HOSTTYPE": "\"x86_64\"",
    "CONF_OSTYPE": "\"linux-musl\"",
    "CONF_MACHTYPE": "\"x86_64-cellar-linux-musl\"",
    "DEFAULT_MAIL_DIRECTORY": "\"/nonexistent-bootstrap-mail\"",
    "SIZEOF_SIZE_T": "8",
    "SIZEOF_INTMAX_T": "8",
    "SIZEOF_WCHAR_T": "4",
    "ICONV_CONST": "",
    "restrict": "__restrict",
    "WEXITSTATUS_OFFSET": "8",
    "PACKAGE": '"bash"',
    "LOCALEDIR": '"/nonexistent-bootstrap-locale"',
    "bits16_t": "short",
    "u_bits16_t": "unsigned short",
    "bits32_t": "int",
    "u_bits32_t": "unsigned int",
    "bits64_t": "long",
    "EXTGLOB_DEFAULT": "0",
    "DIRCOMPLETE_EXPAND_DEFAULT": "0",
}

write_file(
    name = "config.h",
    content = "#ifndef _CONFIG_H_\n#define _CONFIG_H_\n" +
              "\n".join(["#define " + name + " 1" for name in FEATURES + CONFIG_ON]) + "\n" +
              "\n".join(["#define " + name + " " + value for name, value in CONFIG_VALUES.items()]) +
              '\n#include "config-top.h"\n#include "config-bot.h"\n#endif\n',
)

# Version values are configuration, matching support/mkversion.sh's release
# output. No current date, build counter or absolute directory is embedded.
write_file(
    name = "version.h",
    content = '#define DISTVERSION "5.2"\n#define BUILDVERSION 1\n#define RELSTATUS "release"\n#define DEFAULT_COMPAT_LEVEL 52\n#define SCCSVERSION "@(#)Bash version 5.2.15(1) release GNU"\n',
)

# Linux pipe capacity is checked with F_GETPIPE_SZ before heredoc writes.
write_file(
    name = "pipesize.h",
    content = "#define PIPESIZE 65536\n",
)

download_file(
    name = "bash-5.2.15.tar.gz",
    hash = "13720965b5f4fc3a0d4b61dd37e7565c741da9a5be24edc2ae00182fc1b3588c",
    size_bytes = 10951502,
    urls = ["https://mirrors.kernel.org/gnu/bash/bash-5.2.15.tar.gz"],
)

generate(
    name = "bash.tar",
    args = [
        "-dc",
        "$(location :bash-5.2.15.tar.gz)",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/gzip:gzip",
)

untar(
    name = "bash-5.2.15",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    flags = [
        "--numeric-owner",
        "-xf",
    ],
    input = ":bash.tar",
    untar = "cellar//bootstrap/stage1/tar:tar",
)

[export_file(name = path) for path in glob([
    "patches/*",
    "tests/*",
])]

generate(
    name = "signames-generator-source",
    args = [
        "$(location :bash-5.2.15[support/mksignames.c])",
        "$(location :patches/signames.before)",
        "$(location :patches/signames.after)",
    ],
    tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
)

generate(
    name = "pathnames.h",
    args = [
        "s|@DEBUGGER_START_FILE@|/nonexistent-bootstrap-debugger|g",
        "$(location :bash-5.2.15[pathnames.h.in])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

generate(
    name = "shell.c",
    args = [
        "$(location :bash-5.2.15[shell.c])",
        "$(location :patches/identity.before)",
        "$(location :patches/identity.after)",
    ],
    tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
)

SOURCE = {path: ":bash-5.2.15[" + path + "]" for path in FILES} | {
    "support/mksignames.c": ":signames-generator-source",
    "shell.c": ":shell.c",
    "config.h": ":config.h",
    "version.h": ":version.h",
    "builtins/pipesize.h": ":pipesize.h",
    "pathnames.h": ":pathnames.h",
}

filegroup(
    name = "generator-source",
    srcs = SOURCE,
)

INCLUDES = [
    ".",
    "include",
    "lib",
    "lib/sh",
    "builtins",
]

[
    [
        [c_object(
            name = name + str(i) + ".o",
            src = ":generator-source[" + path + "]",
            defines = ["BUILDTOOL=1"],
            flags = [
                "-O2",
                "-Werror",
            ],
            logical_includes = INCLUDES,
            logical_source = path,
            object_name = name + str(i) + ".o",
            source_alias = "cellar//bootstrap/stage1/tools:source-alias",
            source_tree = ":generator-source",
            toolchain = CC,
        ) for i, path in enumerate(paths)],
        c_binary(
            name = name,
            libraries = LIBC,
            objects = CRT + [":" + name + str(i) + ".o" for i in range(len(paths))] + CRTN,
            toolchain = CC,
        ),
    ]
    for name, paths in GENERATORS.items()
]

generate(
    name = "parser",
    args = [
        "--no-lines",
        "-d",
        "-o",
        "y.tab.c",
        "source/parse.y",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = [
        "y.tab.c",
        "y.tab.h",
    ],
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":generator-source",
    tool = "cellar//bootstrap/stage1/bison:bison",
)

generate(
    name = "builtins",
    args = [
        "-externfile",
        "builtext.h",
        "-structfile",
        "builtins.c",
    ] + ["source/" + path for path in DEFINITIONS],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    files = [
        "builtext.h",
        "builtins.c",
    ] + [name + ".c" for name in BUILTINS],
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":generator-source",
    tool = ":mkbuiltins",
)

generate(
    name = "syntax.c",
    args = ["-o"],
    tool = ":mksyntax",
)

generate(
    name = "signames.h",
    tool = ":mksignames",
)

filegroup(
    name = "source",
    srcs = SOURCE | {"builtins/" + name + ".c": ":builtins[" + name + ".c]" for name in BUILTINS + ["builtins"]} | {
        "builtins/builtext.h": ":builtins[builtext.h]",
        "syntax.c": ":syntax.c",
        "signames.h": ":signames.h",
        "y.tab.c": ":parser[y.tab.c]",
        "y.tab.h": ":parser[y.tab.h]",
    },
)

GROUPS = {
    "sh": SH,
    "glob": GLOB,
    "readline": READLINE_SOURCES,
    "termcap": TERMCAP,
    "builtins": BUILTIN_STATIC + ["builtins/" + name + ".c" for name in BUILTINS + ["builtins"]],
    "core": CORE + [
        "y.tab.c",
        "syntax.c",
    ],
}

[
    [
        [c_object(
            name = group + "-" + str(i) + ".o",
            src = ":source[" + path + "]",
            defines = ["HAVE_CONFIG_H=1"] + (["SHELL=1"] if group != "termcap" else []) + (["READLINE_LIBRARY=1"] if path == "lib/readline/tilde.c" else []),
            flags = [
                "-O2",
                "-Werror=implicit-function-declaration",
            ] + ([
                "-include",
                "langinfo.h",
            ] if path == "lib/sh/unicode.c" else []) + ([
                "-include",
                "unistd.h",
            ] if group == "termcap" else []),
            logical_includes = INCLUDES,
            logical_source = path,
            object_name = group + str(i) + ".o",
            source_alias = "cellar//bootstrap/stage1/tools:source-alias",
            source_tree = ":source",
            toolchain = CC,
        ) for i, path in enumerate(sources)],
        c_library(
            name = "lib" + group + ".a",
            objects = [":" + group + "-" + str(i) + ".o" for i in range(len(sources))],
            output = "lib" + group + ".a",
            toolchain = CC,
        ) if group != "core" else None,
    ]
    for group, sources in GROUPS.items()
]

c_binary(
    name = "bash",
    libraries = [
        ":libbuiltins.a",
        ":libglob.a",
        ":libsh.a",
        ":libreadline.a",
        ":libtermcap.a",
        ":libsh.a",
        ":libbuiltins.a",
    ] + LIBC,
    objects = CRT + [":core-" + str(i) + ".o" for i in range(len(GROUPS["core"]))] + CRTN,
    output = "bash",
    toolchain = CC,
)

filegroup(
    name = "installation",
    srcs = {
        "bin/bash": ":bash",
        "share/licenses/bash/COPYING": ":bash-5.2.15[COPYING]",
    },
)

command_test(
    name = "version",
    args = ["--version"],
    tool = ":bash",
)

TEST_ENV = {
    "PATH": "/nonexistent-bootstrap-path",
    "LC_ALL": "C.UTF-8",
    "TZ": "UTC0",
    "CELLAR_BOOTSTRAP_IDENTITY": "1",
}

[command_test(
    name = name,
    args = [
        "--noprofile",
        "--norc",
        "$(location :tests/" + name + ".sh)",
    ],
    env = TEST_ENV,
    tool = ":bash",
) for name in [
    "semantics",
    "signals",
    "unicode",
]]

[command_test(
    name = name,
    args = [
        status,
        "$(location :bash)",
        "--noprofile",
        "--norc",
        "-c",
        script,
    ],
    env = TEST_ENV,
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
) for name, status, script in [
    ("reject-syntax", "2", "if then"),
    ("missing-command", "127", "sed --version"),
]]

generate(
    name = "pipeline-result",
    args = [
        "--noprofile",
        "--norc",
        "-c",
        '. "$1" > result',
        "pipeline-test",
        "$(location :tests/pipelines.sh)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = TEST_ENV | {"TMPDIR": "."},
    files = ["result"],
    tool = ":bash",
)

write_file(
    name = "pipeline-expected",
    content = "pipelines and redirection pass\n",
)

command_test(
    name = "pipelines",
    args = [
        "$(location :pipeline-result[result])",
        "$(location :pipeline-expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

c_object(
    name = "pty.o",
    src = "tests/pty.c",
    defines = ["_GNU_SOURCE=1"],
    flags = [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
    ],
    object_name = "pty.o",
    toolchain = CC,
)

c_binary(
    name = "pty-bin",
    libraries = LIBC,
    objects = CRT + [":pty.o"] + CRTN,
    toolchain = CC,
)

write_file(
    name = "inputrc",
    content = "set editing-mode emacs\nset enable-bracketed-paste off\n",
)

generate(
    name = "pty-result",
    args = [
        "$(location :bash)",
        "$(location :inputrc)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    files = ["passed"],
    tool = ":pty-bin",
)

write_file(
    name = "passed",
    content = "passed\n",
)

command_test(
    name = "interactive-job-control-and-readline",
    args = [
        "$(location :pty-result[passed])",
        "$(location :passed)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)
