# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "ungz", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")
load(":sources.bzl", "HEADERS")

MUSL = "cellar//bootstrap/stage1/musl"

SUPPORT = "cellar//bootstrap/stage1/tcc-musl:musl2-libtcc1.a"

CRT = [
    MUSL + ":restored-crt1.o",
    MUSL + ":restored-crti.o",
]

LIBC = [
    MUSL + ":restored-libc.a",
    SUPPORT,
    MUSL + ":restored-libc.a",
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
    "lib/sh/itos.c",
    "lib/sh/zread.c",
    "lib/sh/zwrite.c",
    "lib/sh/shtty.c",
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
    "lib/sh/strindex.c",
    "lib/sh/snprintf.c",
    "lib/sh/mailstat.c",
    "lib/sh/fmtulong.c",
    "lib/sh/fmtullong.c",
    "lib/sh/fmtumax.c",
    "lib/sh/xstrchr.c",
    "lib/sh/zcatfd.c",
]

BUILTINS = [
    "alias",
    "bind",
    "break",
    "builtin",
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
]

GLOB = ["lib/glob/" + name + ".c" for name in [
    "glob",
    "strmatch",
    "smatch",
    "xmbsrtowcs",
]]

TILDE = ["lib/tilde/tilde.c"]

BUILTIN_STATIC = ["builtins/" + name + ".c" for name in [
    "common",
    "evalstring",
    "evalfile",
    "getopt",
    "bashgetopt",
]]

DEFINITIONS = ["builtins/" + name + ".def" for name in BUILTINS + ["reserved"]]

GENERATORS = {
    "mkbuiltins": "builtins/mkbuiltins.c",
    "mksyntax": "mksyntax.c",
    "mksignames": "support/mksignames.c",
}

FILES = CORE + SH + GLOB + TILDE + BUILTIN_STATIC + DEFINITIONS + GENERATORS.values() + HEADERS + [
    "lib/glob/glob_loop.c",
    "lib/glob/sm_loop.c",
    "COPYING",
    "parse.y",
]

# Reviewed x86_64 Linux/musl results. Readline, history and loadable builtins
# are not required for the generator shell; native job control is enabled.
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
    "HAVE_CONFSTR",
    "HAVE_DECL_CONFSTR",
    "HAVE_DECL_PRINTF",
    "HAVE_DECL_SBRK",
    "HAVE_DECL_STRCPY",
    "HAVE_DECL_STRSIGNAL",
    "HAVE_DECL_STRTOIMAX",
    "HAVE_DECL_STRTOL",
    "HAVE_DECL_STRTOLD",
    "HAVE_DECL_STRTOLL",
    "HAVE_DECL_STRTOUL",
    "HAVE_DECL_STRTOULL",
    "HAVE_DECL_STRTOUMAX",
    "HAVE_DEV_FD",
    "HAVE_DEV_STDIN",
    "HAVE_DIRENT_H",
    "HAVE_DLFCN_H",
    "HAVE_DUP2",
    "HAVE_GETADDRINFO",
    "HAVE_GETCWD",
    "HAVE_GETDTABLESIZE",
    "HAVE_GETGROUPS",
    "HAVE_GETHOSTBYNAME",
    "HAVE_GETHOSTNAME",
    "HAVE_GETPAGESIZE",
    "HAVE_GETPEERNAME",
    "HAVE_GETPW_DECLS",
    "HAVE_GETRLIMIT",
    "HAVE_GETRUSAGE",
    "HAVE_GETSERVBYNAME",
    "HAVE_GETSERVENT",
    "HAVE_GETTIMEOFDAY",
    "HAVE_GRP_H",
    "HAVE_HASH_BANG_EXEC",
    "HAVE_INET_ATON",
    "HAVE_INTTYPES_H",
    "HAVE_ISASCII",
    "HAVE_ISBLANK",
    "HAVE_ISGRAPH",
    "HAVE_ISINF_IN_LIBC",
    "HAVE_ISPRINT",
    "HAVE_ISSPACE",
    "HAVE_ISXDIGIT",
    "HAVE_KILLPG",
    "HAVE_LANGINFO_CODESET",
    "HAVE_LANGINFO_H",
    "HAVE_LIMITS_H",
    "HAVE_LOCALE_H",
    "HAVE_LONG_DOUBLE",
    "HAVE_LONG_LONG",
    "HAVE_LSTAT",
    "HAVE_MBSRTOWCS",
    "HAVE_MBSTATE_T",
    "HAVE_MEMMOVE",
    "HAVE_MEMORY_H",
    "HAVE_MEMSET",
    "HAVE_MKFIFO",
    "HAVE_NETDB_H",
    "HAVE_NETINET_IN_H",
    "HAVE_PATHCONF",
    "HAVE_POSIX_SIGNALS",
    "HAVE_POSIX_SIGSETJMP",
    "HAVE_PRINTF_A_FORMAT",
    "HAVE_PUTENV",
    "HAVE_READLINK",
    "HAVE_RENAME",
    "HAVE_SBRK",
    "HAVE_SELECT",
    "HAVE_SETENV",
    "HAVE_SETLINEBUF",
    "HAVE_SETLOCALE",
    "HAVE_SETVBUF",
    "HAVE_SIGINTERRUPT",
    "HAVE_SNPRINTF",
    "HAVE_STDARG_H",
    "HAVE_STDDEF_H",
    "HAVE_STDINT_H",
    "HAVE_STDLIB_H",
    "HAVE_STD_PUTENV",
    "HAVE_STD_UNSETENV",
    "HAVE_STRCASECMP",
    "HAVE_STRCHR",
    "HAVE_STRCOLL",
    "HAVE_STRERROR",
    "HAVE_STRFTIME",
    "HAVE_STRINGIZE",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_STRPBRK",
    "HAVE_STRSIGNAL",
    "HAVE_STRTOD",
    "HAVE_STRTOIMAX",
    "HAVE_STRTOL",
    "HAVE_STRTOLL",
    "HAVE_STRTOUL",
    "HAVE_STRTOULL",
    "HAVE_STRTOUMAX",
    "HAVE_STRUCT_STAT_ST_BLOCKS",
    "HAVE_STRUCT_TM_TM_ZONE",
    "HAVE_SYSCONF",
    "HAVE_SYS_FILE_H",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_RESOURCE_H",
    "HAVE_SYS_SELECT_H",
    "HAVE_SYS_SOCKET_H",
    "HAVE_SYS_TIMES_H",
    "HAVE_SYS_TIME_H",
    "HAVE_SYS_WAIT_H",
    "HAVE_TCGETATTR",
    "HAVE_TCGETPGRP",
    "HAVE_TERMIOS_H",
    "HAVE_TERMIO_H",
    "HAVE_TIMES",
    "HAVE_TIMEVAL",
    "HAVE_TM_ZONE",
    "HAVE_TTYNAME",
    "HAVE_TZNAME",
    "HAVE_TZSET",
    "HAVE_ULIMIT",
    "HAVE_UNAME",
    "HAVE_UNISTD_H",
    "HAVE_UNSETENV",
    "HAVE_UNSIGNED_LONG_LONG",
    "HAVE_VASPRINTF",
    "HAVE_VPRINTF",
    "HAVE_VSNPRINTF",
    "HAVE_WAIT3",
    "HAVE_WAITPID",
    "HAVE_WCHAR_H",
    "HAVE_WCTYPE_H",
    "HAVE_WCWIDTH",
    "PROTOTYPES",
    "STDC_HEADERS",
    "STRUCT_DIRENT_HAS_D_INO",
    "STRUCT_WINSIZE_IN_SYS_IOCTL",
    "TIME_WITH_SYS_TIME",
    "VOID_SIGHANDLER",
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
    "DEV_FD_PREFIX": '"/dev/fd/"',
    "DEFAULT_PATH_VALUE": '"/bootstrap/bin"',
    "STANDARD_UTILS_PATH": '"/bootstrap/bin"',
    "CONF_HOSTTYPE": '"x86_64"',
    "CONF_OSTYPE": '"linux-musl"',
    "CONF_MACHTYPE": '"x86_64-unknown-linux-musl"',
    "DEFAULT_MAIL_DIRECTORY": '"/nonexistent-bootstrap-mail"',
}

write_file(
    name = "config.h",
    content = "#ifndef _CONFIG_H_\n#define _CONFIG_H_\n" +
              "\n".join(["#define " + name + " 1" for name in FEATURES + CONFIG_ON]) + "\n" +
              "\n".join(["#define " + name + " " + value for name, value in CONFIG_VALUES.items()]) +
              '\n#include "config-top.h"\n#include "config-bot.h"\n#endif\n',
)

write_file(
    name = "version.h",
    content = '#define DISTVERSION "2.05b"\n#define BUILDVERSION 0\n#define SCCSVERSION "2.05b"\n#define RELSTATUS "release"\nextern char *shell_version_string(void);\nextern void show_shell_version(int);\n',
)

write_file(
    name = "pipesize.h",
    content = "#define PIPESIZE 4096\n",
)

download_file(
    name = "bash-2.05b.tar.gz",
    hash = "ba03d412998cc54bd0b0f2d6c32100967d3137098affdc2d32e6e7c11b163fe4",
    urls = ["https://mirrors.kernel.org/gnu/bash/bash-2.05b.tar.gz"],
)

ungz(
    name = "bash.tar",
    input = ":bash-2.05b.tar.gz",
    ungz = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name = "bash-2.05b",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    input = ":bash.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

[export_file(name = path) for path in glob([
    "patches/*",
    "tests/*.sh",
])]

generate(
    name = "shell-source",
    args = [
        "$(location :bash-2.05b[shell.c])",
        "$(location :patches/user-info.before)",
        "$(location :patches/user-info.after)",
    ],
    tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
)

generate(
    name = "externs-source",
    args = [
        "$(location :bash-2.05b[externs.h])",
        "$(location :patches/zcatfd.before)",
        "$(location :patches/zcatfd.after)",
    ],
    tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
)

generate(
    name = "redir-source",
    args = [
        "$(location :bash-2.05b[redir.c])",
        "$(location :patches/heredoc.before)",
        "$(location :patches/heredoc.after)",
    ],
    tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
)

SOURCE = {path: ":bash-2.05b[" + path + "]" for path in FILES} | {
    "shell.c": ":shell-source",
    "redir.c": ":redir-source",
    "externs.h": ":externs-source",
    "config.h": ":config.h",
    "version.h": ":version.h",
    "include/pipesize.h": ":pipesize.h",
}

filegroup(
    name = "generator-source",
    srcs = SOURCE,
)

[
    [
        c_object(
            name = name + ".o",
            src = ":generator-source[" + path + "]",
            flags = ["-Werror"],
            headers = [
                ":generator-source",
                MUSL + ":headers",
            ],
            # do not sort
            includes = [
                ":generator-source",
                ":generator-source[include]",
                ":generator-source[lib]",
            ],
            object_name = name + ".o",
            toolchain = MUSL + ":tcc",
        ),
        c_binary(
            name = name,
            libraries = LIBC,
            objects = CRT + [
                ":" + name + ".o",
                MUSL + ":restored-crtn.o",
            ],
            toolchain = MUSL + ":tcc",
        ),
    ]
    for name, path in GENERATORS.items()
]

generate(
    name = "parser",
    args = [
        "-d",
        "-l",
        "-o",
        "y.tab.c",
        "$(location :generator-source[parse.y])",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = [
        "y.tab.c",
        "y.tab.h",
    ],
    tool = "cellar//bootstrap/stage1/oyacc:oyacc",
)

generate(
    name = "builtins",
    args = [
        "-externfile",
        "builtext.h",
        "-structfile",
        "builtins.c",
    ] + ["$(location :generator-source[" + path + "])" for path in DEFINITIONS],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    files = [
        "builtext.h",
        "builtins.c",
    ] + [name + ".c" for name in BUILTINS],
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
    "tilde": TILDE,
    "builtins": BUILTIN_STATIC + ["builtins/" + name + ".c" for name in BUILTINS + ["builtins"]],
    "core": CORE + [
        "y.tab.c",
        "syntax.c",
    ],
}

[
    [
        [
            c_object(
                name = group + "-{}.o".format(i),
                src = ":source[" + path + "]",
                defines = [
                    "SHELL=1",
                    "HAVE_CONFIG_H=1",
                ],
                flags = ["-Werror"],
                headers = [
                    ":source",
                    MUSL + ":headers",
                ],
                # do not sort
                includes = [
                    ":source",
                    ":source[include]",
                    ":source[lib]",
                    ":source[lib/sh]",
                    ":source[builtins]",
                ],
                object_name = group + "{}.o".format(i),
                toolchain = MUSL + ":tcc",
            )
            for i, path in enumerate(sources)
        ],
        c_library(
            name = "lib" + group + ".a",
            objects = [":" + group + "-{}.o".format(i) for i in range(len(sources))],
            output = "lib" + group + ".a",
            toolchain = MUSL + ":tcc",
        ) if group != "core" else None,
    ]
    for group, sources in GROUPS.items()
]

c_binary(
    name = "bash",
    libraries = [
        ":libbuiltins.a",
        ":libglob.a",
        ":libtilde.a",
        ":libsh.a",
        ":libbuiltins.a",
        ":libsh.a",
    ] + LIBC,
    objects = CRT + [":core-{}.o".format(i) for i in range(len(GROUPS["core"]))] + [MUSL + ":restored-crtn.o"],
    output = "bash",
    toolchain = MUSL + ":tcc",
)

command_test(
    name = "version",
    args = ["--version"],
    tool = ":bash",
)

[
    command_test(
        name = name,
        args = [
            "--noprofile",
            "--norc",
            "$(location :tests/" + name + ".sh)",
        ],
        env = {
            "PATH": "/nonexistent-bootstrap-tools",
            "LC_ALL": "C.UTF-8",
        },
        tool = ":bash",
    )
    for name in [
        "semantics",
        "signals",
        "unicode",
    ]
]

command_test(
    name = "reject-syntax",
    args = [
        "2",
        "$(location :bash)",
        "--noprofile",
        "--norc",
        "-c",
        "if then",
    ],
    env = {"PATH": "/nonexistent-bootstrap-tools"},
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

command_test(
    name = "missing-command",
    args = [
        "127",
        "$(location :bash)",
        "--noprofile",
        "--norc",
        "-c",
        "sed --version",
    ],
    env = {"PATH": "/nonexistent-bootstrap-tools"},
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

# Here-documents are temporary action data, kept in the declared work directory.
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
    env = {
        "TMPDIR": ".",
        "PATH": "/nonexistent-bootstrap-tools",
        "LC_ALL": "C.UTF-8",
    },
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
