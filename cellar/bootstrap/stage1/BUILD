# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate", "installed_tool")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")
load("@cellar//bootstrap/stage1/musl12:defs.bzl", "INSTALLED_HEADERS")

GCC = "cellar//bootstrap/stage1/gcc13"

MUSL = "cellar//bootstrap/stage1/musl12"

CXX = "cellar//bootstrap/stage1/libstdcxx13"

PREFIX = "cellar//bootstrap/stage1/"

# Explicit program manifests. BUILD owns every installed name and source.
USER_PROGRAMS = {
    "chroot": "coreutils-final:installation[bin/chroot]",
    "df": "coreutils-final:installation[bin/df]",
    "hostid": "coreutils-final:installation[bin/hostid]",
    "nice": "coreutils-final:installation[bin/nice]",
    "pinky": "coreutils-final:installation[bin/pinky]",
    "stty": "coreutils-final:installation[bin/stty]",
    "uname": "coreutils-final:installation[bin/uname]",
    "uptime": "coreutils-final:installation[bin/uptime]",
    "users": "coreutils-final:installation[bin/users]",
    "who": "coreutils-final:installation[bin/who]",
    "[": "coreutils-final:lbracket",
    "chcon": "coreutils-final:installation[bin/chcon]",
    "chgrp": "coreutils-final:installation[bin/chgrp]",
    "chown": "coreutils-final:installation[bin/chown]",
    "chmod": "coreutils-final:installation[bin/chmod]",
    "cp": "coreutils-final:installation[bin/cp]",
    "dd": "coreutils-final:installation[bin/dd]",
    "dircolors": "coreutils-final:installation[bin/dircolors]",
    "du": "coreutils-final:installation[bin/du]",
    "install": "coreutils-final:installation[bin/install]",
    "link": "coreutils-final:installation[bin/link]",
    "ln": "coreutils-final:installation[bin/ln]",
    "dir": "coreutils-final:installation[bin/dir]",
    "vdir": "coreutils-final:installation[bin/vdir]",
    "ls": "coreutils-final:installation[bin/ls]",
    "mkdir": "coreutils-final:installation[bin/mkdir]",
    "mkfifo": "coreutils-final:installation[bin/mkfifo]",
    "mknod": "coreutils-final:installation[bin/mknod]",
    "mktemp": "coreutils-final:installation[bin/mktemp]",
    "mv": "coreutils-final:installation[bin/mv]",
    "nohup": "coreutils-final:installation[bin/nohup]",
    "readlink": "coreutils-final:installation[bin/readlink]",
    "rm": "coreutils-final:installation[bin/rm]",
    "rmdir": "coreutils-final:installation[bin/rmdir]",
    "shred": "coreutils-final:installation[bin/shred]",
    "stat": "coreutils-final:installation[bin/stat]",
    "sync": "coreutils-final:installation[bin/sync]",
    "touch": "coreutils-final:installation[bin/touch]",
    "unlink": "coreutils-final:installation[bin/unlink]",
    "cat": "coreutils-final:installation[bin/cat]",
    "cksum": "coreutils-final:installation[bin/cksum]",
    "comm": "coreutils-final:installation[bin/comm]",
    "csplit": "coreutils-final:installation[bin/csplit]",
    "cut": "coreutils-final:installation[bin/cut]",
    "expand": "coreutils-final:installation[bin/expand]",
    "fmt": "coreutils-final:installation[bin/fmt]",
    "fold": "coreutils-final:installation[bin/fold]",
    "head": "coreutils-final:installation[bin/head]",
    "join": "coreutils-final:installation[bin/join]",
    "md5sum": "coreutils-final:installation[bin/md5sum]",
    "nl": "coreutils-final:installation[bin/nl]",
    "od": "coreutils-final:installation[bin/od]",
    "paste": "coreutils-final:installation[bin/paste]",
    "pr": "coreutils-final:installation[bin/pr]",
    "ptx": "coreutils-final:installation[bin/ptx]",
    "sha1sum": "coreutils-final:installation[bin/sha1sum]",
    "sha224sum": "coreutils-final:installation[bin/sha224sum]",
    "sha256sum": "coreutils-final:installation[bin/sha256sum]",
    "sha384sum": "coreutils-final:installation[bin/sha384sum]",
    "sha512sum": "coreutils-final:installation[bin/sha512sum]",
    "shuf": "coreutils-final:installation[bin/shuf]",
    "sort": "coreutils-final:installation[bin/sort]",
    "split": "coreutils-final:installation[bin/split]",
    "sum": "coreutils-final:installation[bin/sum]",
    "tac": "coreutils-final:installation[bin/tac]",
    "tail": "coreutils-final:installation[bin/tail]",
    "tr": "coreutils-final:installation[bin/tr]",
    "tsort": "coreutils-final:installation[bin/tsort]",
    "unexpand": "coreutils-final:installation[bin/unexpand]",
    "uniq": "coreutils-final:installation[bin/uniq]",
    "wc": "coreutils-final:installation[bin/wc]",
    "basename": "coreutils-final:installation[bin/basename]",
    "date": "coreutils-final:installation[bin/date]",
    "dirname": "coreutils-final:installation[bin/dirname]",
    "echo": "coreutils-final:installation[bin/echo]",
    "env": "coreutils-final:installation[bin/env]",
    "expr": "coreutils-final:installation[bin/expr]",
    "factor": "coreutils-final:installation[bin/factor]",
    "false": "coreutils-final:installation[bin/false]",
    "id": "coreutils-final:installation[bin/id]",
    "kill": "coreutils-final:installation[bin/kill]",
    "logname": "coreutils-final:installation[bin/logname]",
    "pathchk": "coreutils-final:installation[bin/pathchk]",
    "printenv": "coreutils-final:installation[bin/printenv]",
    "printf": "coreutils-final:installation[bin/printf]",
    "pwd": "coreutils-final:installation[bin/pwd]",
    "runcon": "coreutils-final:installation[bin/runcon]",
    "seq": "coreutils-final:installation[bin/seq]",
    "sleep": "coreutils-final:installation[bin/sleep]",
    "tee": "coreutils-final:installation[bin/tee]",
    "test": "coreutils-final:installation[bin/test]",
    "true": "coreutils-final:installation[bin/true]",
    "tty": "coreutils-final:installation[bin/tty]",
    "whoami": "coreutils-final:installation[bin/whoami]",
    "yes": "coreutils-final:installation[bin/yes]",
    "base64": "coreutils-final:installation[bin/base64]",
    "bash": "bash:installation[bin/bash]",
    "make": "make:installation[bin/make]",
    "find": "findutils:installation[bin/find]",
    "xargs": "findutils:installation[bin/xargs]",
    "locate": "findutils:installation[bin/locate]",
    "diff": "diffutils:installation[bin/diff]",
    "cmp": "diffutils:installation[bin/cmp]",
    "diff3": "diffutils:installation[bin/diff3]",
    "sdiff": "diffutils:installation[bin/sdiff]",
    "sed": "sed-final:installation[bin/sed]",
    "grep": "grep:installation[bin/grep]",
    "egrep": "grep:installation[bin/egrep]",
    "fgrep": "grep:installation[bin/fgrep]",
    "gawk": "gawk-final:installation[bin/gawk]",
    "tar": "tar-final:installation[bin/tar]",
    "gzip": "gzip:installation[bin/gzip]",
    "bzip2": "bzip2:installation[bin/bzip2]",
    "bzip2recover": "bzip2:installation[bin/bzip2recover]",
    "patch": "patch:installation[bin/patch]",
    "m4": "m4-final:installation[bin/m4]",
    "flex": "flex-final:installation[bin/flex]",
    "bison": "bison-final:installation[bin/bison]",
}

BINUTILS = [
    "size",
    "objcopy",
    "strings",
    "readelf",
    "elfedit",
    "strip",
    "nm",
    "objdump",
    "c++filt",
    "ar",
    "ranlib",
    "addr2line",
    "as",
    "ld",
    "gprof",
]

ALIASES = {
    "sh": "bash",
    "awk": "gawk",
    "gunzip": "gzip",
    "zcat": "gzip",
    "bunzip2": "bzip2",
    "bzcat": "bzip2",
    "lex": "flex",
}

# Each profile is (relative executable, extra arguments, compiler, C++).
PROFILES = {name: (
    "libexec/bootstrap/" + name,
    [],
    False,
    False,
) for name in USER_PROGRAMS} | {
    name: (
        "libexec/bootstrap/" + target,
        [],
        False,
        False,
    )
    for name, target in ALIASES.items()
} | {name: (
    "libexec/binutils/" + name,
    [],
    False,
    False,
) for name in BINUTILS} | {
    "gcc": ("libexec/gcc/x86_64-cellar-linux-musl/13.5.0/gcc", [], True, False),
    "cc": ("libexec/gcc/x86_64-cellar-linux-musl/13.5.0/gcc", [], True, False),
    "g++": ("libexec/gcc/x86_64-cellar-linux-musl/13.5.0/g++", [], True, True),
    "c++": ("libexec/gcc/x86_64-cellar-linux-musl/13.5.0/g++", [], True, True),
    "cpp": ("libexec/gcc/x86_64-cellar-linux-musl/13.5.0/cpp", [], True, False),
    "gcov": ("libexec/gcc/x86_64-cellar-linux-musl/13.5.0/gcov", [], False, False),
    "yacc": (
        "libexec/bootstrap/bison",
        ["-y"],
        False,
        False,
    ),
    "groups": (
        "libexec/bootstrap/bash",
        [
            "--noprofile",
            "--norc",
            "{root}/libexec/bootstrap/groups",
        ],
        False,
        False,
    ),
    "updatedb": (
        "libexec/bootstrap/bash",
        [
            "--noprofile",
            "--norc",
            "{root}/libexec/bootstrap/updatedb",
        ],
        False,
        False,
    ),
}

ENVIRONMENT = [
    "BOOTSTRAP_SHELL={root}/bin/bash",
    "SHELL={root}/bin/bash",
    "CONFIG_SHELL={root}/bin/bash",
    "TMPDIR?=/tmp",
]

# Settings that only some programs read reach only those programs. Every other
# program keeps the caller's value of a common name like BINDIR, and no
# program passes one installation's paths on to another's.
M4 = "M4={root}/bin/m4"

AWKPATH = "AWKPATH?={root}/share/awk"

BISON = [
    "BISON_PKGDATADIR={root}/share/bison",
    M4,
]

PROGRAM_ENVIRONMENT = {
    "awk": [AWKPATH],
    "gawk": [AWKPATH],
    "bison": BISON,
    "yacc": BISON,
    "flex": [M4],
    "lex": [M4],
    "locate": ["LOCATE_PATH?={root}/var/locatedb"],
    "updatedb": [
        "BINDIR={root}/bin",
        "LIBEXECDIR={root}/libexec",
        "LOCATE_DB?={root}/var/locatedb",
    ],
}

COMPILER_ARGUMENTS = [
    "-B{root}/libexec/gcc/x86_64-cellar-linux-musl/13.5.0/",
    "-B{root}/lib/",
    "-L{root}/lib",
    "-nostdinc",
    "-g0",
    "-frandom-seed=bootstrap",
    "-Wno-builtin-macro-redefined",
    '-D__DATE__="Jan  1 1970"',
    '-D__TIME__="00:00:00"',
    '-D__TIMESTAMP__="Thu Jan  1 00:00:00 1970"',
]

C_INCLUDES = [
    "-isystem",
    "{root}/lib/gcc/x86_64-cellar-linux-musl/13.5.0/include",
    "-isystem",
    "{root}/include",
]

CXX_INCLUDES = [
    "-nostdinc++",
    "-isystem",
    "{root}/include/c++/13.5.0",
]

COMPILER_UNSET = [
    "GCC_EXEC_PREFIX",
    "COMPILER_PATH",
    "LIBRARY_PATH",
    "CPATH",
    "C_INCLUDE_PATH",
    "CPLUS_INCLUDE_PATH",
    "OBJC_INCLUDE_PATH",
]

# Make recurses through PATH, so its MAKE variable stays usable when the
# installation prefix contains spaces. Other tools preserve the caller argv0.
write_file(
    name = "launch-config.h",
    content = "\n".join([
        "static const char *const " + name + "[] = {" + ", ".join([json.encode(v) for v in values] + ["NULL"]) + "};"
        for name, values in {
            "environment": ENVIRONMENT,
            "compiler_arguments": COMPILER_ARGUMENTS,
            "c_includes": C_INCLUDES,
            "cxx_includes": CXX_INCLUDES,
            "compiler_unset": COMPILER_UNSET,
        }.items()
    ] + [
        "static const char *const args_" + str(i) + "[] = {" + ", ".join([json.encode(v) for v in profile[1]] + ["NULL"]) + "};"
        for i, profile in enumerate(PROFILES.values())
    ] + [
        "static const char *const environment_" + str(i) + "[] = {" + ", ".join([json.encode(v) for v in PROGRAM_ENVIRONMENT.get(name, [])] + ["NULL"]) + "};"
        for i, name in enumerate(PROFILES)
    ] + ["static const struct profile profiles[] = {"] + [
        "{" + json.encode(name) + ", " + json.encode("{root}/" + profile[0]) + ", " + (json.encode("make") if name == "make" else "NULL") + ", " + ("1" if profile[2] else "0") + ", " + ("1" if profile[3] else "0") + ", args_" + str(i) + ", environment_" + str(i) + "},"
        for i, (name, profile) in enumerate(PROFILES.items())
    ] + [
        "};",
        "",
    ]),
)

filegroup(
    name = "launcher-source",
    srcs = {
        "launcher.c": "installation/launcher.c",
        "launch-config.h": ":launch-config.h",
    },
)

c_object(
    name = "launcher.o",
    src = ":launcher-source[launcher.c]",
    flags = [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
    ],
    logical_includes = ["."],
    logical_source = "launcher.c",
    object_name = "launch.o",
    source_alias = PREFIX + "tools:source-alias",
    source_tree = ":launcher-source",
    toolchain = GCC + ":stage3-gcc",
)

c_binary(
    name = "launcher",
    end_objects = [
        GCC + ":stage3-crtend.o",
        MUSL + ":crtn.o",
    ],
    libraries = [
        MUSL + ":libc.a",
        GCC + ":stage3-libgcc.a",
        MUSL + ":libc.a",
    ],
    objects = [
        MUSL + ":crt1.o",
        MUSL + ":crti.o",
        GCC + ":stage3-crtbeginT.o",
        ":launcher.o",
    ],
    output = "launcher",
    toolchain = GCC + ":stage3-gcc",
)

LIBRARIES = [
    "c",
    "m",
    "pthread",
    "dl",
    "rt",
    "util",
    "resolv",
    "xnet",
]

GCC_OBJECTS = [
    "crtbeginT.o",
    "crtend.o",
    "crtprec32.o",
    "crtprec64.o",
    "crtprec80.o",
    "crtfastmath.o",
]

TOOLCHAIN_FILES = {"include/" + p: MUSL + ":headers[" + p + "]" for p in INSTALLED_HEADERS} | {
    "include/c++/13.5.0": CXX + ":headers",
    "lib/gcc/x86_64-cellar-linux-musl/13.5.0/include": GCC + ":compiler-headers",
    "lib/libstdc++.a": CXX + ":stage3-libstdc++.a",
    "lib/libsupc++.a": CXX + ":stage3-libsupc++.a",
    "lib/libstdc++fs.a": CXX + ":stage3-libstdc++fs.a",
    "lib/libstdc++exp.a": CXX + ":stage3-libstdc++exp.a",
    "lib/libgcc.a": GCC + ":stage3-libgcc.a",
    "lib/libgcov.a": GCC + ":stage3-libgcov.a",
    "share/licenses/libstdc++": CXX + ":stage3-installation[share/licenses/libstdc++]",
    "share/licenses/binutils": PREFIX + "binutils241:installation[share/licenses/binutils]",
    "share/licenses/gmp": PREFIX + "gmp:installation[share/licenses/gmp]",
    "share/licenses/mpfr": PREFIX + "mpfr:installation[share/licenses/mpfr]",
    "share/licenses/mpc": PREFIX + "mpc:installation[share/licenses/mpc]",
    "share/licenses/libbacktrace/LICENSE": GCC + ":libbacktrace-notice",
    "share/licenses/libcody/LICENSE": GCC + ":gcc-13.5.0[libcody/LICENSE]",
    "share/licenses/mimalloc/LICENSE": PREFIX + "mimalloc:mimalloc-3.5.3[LICENSE]",
    "share/ldscripts": PREFIX + "binutils241:installation[share/ldscripts]",
} | {"lib/lib" + name + ".a": MUSL + ":lib" + name + ".a" for name in LIBRARIES} | {
    "lib/" + name: MUSL + ":" + name
    for name in [
        "crt1.o",
        "crti.o",
        "crtn.o",
    ]
} | {"lib/" + name: GCC + ":stage3-" + name for name in GCC_OBJECTS} | {
    "libexec/gcc/x86_64-cellar-linux-musl/13.5.0/" + name: GCC + ":stage3-" + target
    for name, target in {
        "gcc": "xgcc",
        "g++": "g++",
        "cpp": "cpp",
        "gcov": "gcov",
        "cc1": "cc1",
        "cc1plus": "cc1plus",
    }.items()
} | {"libexec/gcc/x86_64-cellar-linux-musl/13.5.0/" + name: PREFIX + "binutils241:" + name for name in [
    "as",
    "ld",
]} | {
    "libexec/binutils/" + name: PREFIX + "binutils241:" + name
    for name in BINUTILS
} | {"bin/" + name: ":launcher" for name in BINUTILS + [
    "gcc",
    "cc",
    "g++",
    "c++",
    "cpp",
    "gcov",
]}

USERLAND_FILES = {"libexec/bootstrap/" + name: PREFIX + target for name, target in USER_PROGRAMS.items()} | {
    "libexec/bootstrap/groups": PREFIX + "coreutils-final:groups-script",
    "libexec/bootstrap/updatedb": PREFIX + "findutils:updatedb-script",
    "include/FlexLexer.h": PREFIX + "flex-final:installation[include/FlexLexer.h]",
    "include/bzlib.h": PREFIX + "bzip2:installation[include/bzlib.h]",
    "include/gnumake.h": PREFIX + "make:installation[include/gnumake.h]",
    "lib/libfl.a": PREFIX + "flex-final:libfl.a",
    "lib/libbz2.a": PREFIX + "bzip2:libbz2.a",
    "share/awk": PREFIX + "gawk-final:data",
    "share/bison": PREFIX + "bison-final:data",
} | {"libexec/" + name: PREFIX + "findutils:" + name + "-bin" for name in [
    "frcode",
    "code",
    "bigram",
]} | {
    "share/licenses/" + name: PREFIX + package + ":installation[share/licenses/" + name + "]"
    for name, package in {
        "bash": "bash",
        "make": "make",
        "coreutils": "coreutils-final",
        "findutils": "findutils",
        "diffutils": "diffutils",
        "sed": "sed-final",
        "grep": "grep",
        "gawk": "gawk-final",
        "tar": "tar-final",
        "gzip": "gzip",
        "bzip2": "bzip2",
        "patch": "patch",
        "m4": "m4-final",
        "flex": "flex-final",
        "bison": "bison-final",
    }.items()
} | {"bin/" + name: ":launcher" for name in list(USER_PROGRAMS) + list(ALIASES) + [
    "yacc",
    "groups",
    "updatedb",
]}

# updatedb and locate default to {root}/var/locatedb, so every installation
# ships the directory that database lives in.
filegroup(
    name = "empty-directory",
    srcs = {},
)

# Every installation links musl and libgcc into its programs, so each carries
# their notices.
COMMON_FILES = {
    "var": ":empty-directory",
    "share/bootstrap/README": "installation/README",
    "share/licenses/bootstrap/LICENSE": "installation/LICENSE",
    "share/licenses/bootstrap/NOTICE": "installation/NOTICE",
    "share/licenses/musl/COPYRIGHT": MUSL + ":source[COPYRIGHT]",
    "share/licenses/gcc/COPYING3": GCC + ":gcc-13.5.0[COPYING3]",
    "share/licenses/gcc/COPYING.RUNTIME": GCC + ":gcc-13.5.0[COPYING.RUNTIME]",
}

INSTALLATIONS = {
    "toolchain": TOOLCHAIN_FILES,
    "userland": USERLAND_FILES,
    "all": TOOLCHAIN_FILES | USERLAND_FILES,
}

[write_file(
    name = name + "-manifest",
    content = "\n".join([path + "\t" + (files | COMMON_FILES)[path] for path in sorted(files | COMMON_FILES)]) + "\n",
) for name, files in INSTALLATIONS.items()]

[filegroup(
    name = name,
    srcs = files | COMMON_FILES | {"share/bootstrap/manifest.tsv": ":" + name + "-manifest"},
) for name, files in INSTALLATIONS.items()]

[installed_tool(
    name = ("lbracket" if name == "[" else name),
    installation = ":all",
    path = "bin/" + name,
) for name in PROFILES]

filegroup(
    name = "acceptance-source",
    srcs = {name: "installation/tests/" + name for name in [
        "acceptance.sh",
        "Makefile",
        "helper.c",
        "native.c",
        "native.cc",
    ]} | {
        "cpp.l": PREFIX + "flex-final:cpp.l",
        "cpp.y": PREFIX + "bison-final:cpp.y",
        "calculator.y": PREFIX + "bison:calculator.y",
    },
)

write_file(
    name = "passed",
    content = "passed\n",
)

[[
    generate(
        name = "acceptance-" + name,
        args = [
            "--noprofile",
            "--norc",
            "source/acceptance.sh",
            name,
            "$(location :all)",
        ],
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        env = {
            "PATH": "/nonexistent-bootstrap-path",
            "TMPDIR": ".",
            "CELLAR_BOOTSTRAP_IDENTITY": "1",
            "TZ": "UTC0",
            "LC_ALL": "C.UTF-8",
        },
        files = ["passed"],
        source_alias = PREFIX + "tools:source-alias",
        source_tree = ":acceptance-source",
        tool = ":bash",
    ),
    command_test(
        name = "installed-" + name,
        args = [
            "$(location :acceptance-" + name + "[passed])",
            "$(location :passed)",
        ],
        tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
    ),
] for name in [
    "versions",
    "compilation",
    "generators",
    "files-and-archives",
    "locate",
    "relocation",
]]
