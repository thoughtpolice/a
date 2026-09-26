# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "generate", "installed_tool", "result_test")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")
load("@cellar//bootstrap/stage1/binutils241:sources.bzl", "BINUTILS_PROGRAMS")
load("@cellar//bootstrap/stage1/coreutils-final:programs.bzl", COREUTILS = "PROGRAMS")
load("@cellar//bootstrap/stage1/musl12:defs.bzl", "INSTALLED_HEADERS")
load(":defs.bzl", "c_strings")

GCC = "cellar//bootstrap/stage1/gcc13"

MUSL = "cellar//bootstrap/stage1/musl12"

CXX = "cellar//bootstrap/stage1/libstdcxx13"

PREFIX = "cellar//bootstrap/stage1/"

# The installed compiler's own programs and headers.
GCC_LIBEXEC = "libexec/gcc/x86_64-cellar-linux-musl/13.5.0"

GCC_INCLUDE = "lib/gcc/x86_64-cellar-linux-musl/13.5.0/include"

# The userland packages and the programs each installs, in launcher order.
USERLAND = {
    "coreutils-final": ["[" if name == "lbracket" else name for name in COREUTILS],
    "bash": ["bash"],
    "make": ["make"],
    "findutils": [
        "find",
        "xargs",
        "locate",
    ],
    "diffutils": [
        "diff",
        "cmp",
        "diff3",
        "sdiff",
    ],
    "sed-final": ["sed"],
    "grep": [
        "grep",
        "egrep",
        "fgrep",
    ],
    "gawk-final": ["gawk"],
    "tar-final": ["tar"],
    "gzip": ["gzip"],
    "bzip2": [
        "bzip2",
        "bzip2recover",
    ],
    "patch": ["patch"],
    "m4-final": ["m4"],
    "flex-final": ["flex"],
    "bison-final": ["bison"],
}

# A label cannot name the [ subtarget, so [ comes from its own target.
USER_PROGRAMS = {
    program: PREFIX + package + (":lbracket" if program == "[" else ":installation[bin/" + program + "]")
    for package, programs in USERLAND.items()
    for program in programs
}

ALIASES = {
    "sh": "bash",
    "awk": "gawk",
    "gunzip": "gzip",
    "zcat": "gzip",
    "bunzip2": "bzip2",
    "bzcat": "bzip2",
    "lex": "flex",
}

BINUTILS = list(BINUTILS_PROGRAMS) + [
    "as",
    "ld",
    "gprof",
]

# The GCC commands and the program in GCC_LIBEXEC each one runs.
GCC_PROGRAMS = {
    "gcc": "gcc",
    "cc": "gcc",
    "g++": "g++",
    "c++": "g++",
    "cpp": "cpp",
    "gcov": "gcov",
}

# The program each launcher in bin/ runs, relative to the installation.
PROGRAMS = {name: "libexec/bootstrap/" + name for name in USER_PROGRAMS} | {
    name: "libexec/bootstrap/" + target
    for name, target in ALIASES.items()
} | {name: "libexec/binutils/" + name for name in BINUTILS} | {
    name: GCC_LIBEXEC + "/" + program
    for name, program in GCC_PROGRAMS.items()
} | {
    "yacc": "libexec/bootstrap/bison",
    "groups": "libexec/bootstrap/bash",
    "updatedb": "libexec/bootstrap/bash",
}

# Arguments that a launcher passes before the caller's.
ARGUMENTS = {
    "yacc": ["-y"],
    "groups": [
        "--noprofile",
        "--norc",
        "{root}/libexec/bootstrap/groups",
    ],
    "updatedb": [
        "--noprofile",
        "--norc",
        "{root}/libexec/bootstrap/updatedb",
    ],
}

# The compiler drivers, which get the installation's search paths below, and
# whether each one also gets the C++ headers.
COMPILERS = {
    "gcc": False,
    "cc": False,
    "g++": True,
    "c++": True,
    "cpp": False,
}

# Make recurses through PATH, so its MAKE variable stays usable when the
# installation prefix contains spaces. Other programs keep the caller's argv0.
ARGV0 = {"make": "make"}

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
    "-B{root}/" + GCC_LIBEXEC + "/",
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
    "{root}/" + GCC_INCLUDE,
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

# launcher.c includes the shared settings and one profile per command in bin/.
write_file(
    name = "launch-config.h",
    content = "\n".join([
        c_strings(name, values)
        for name, values in {
            "environment": ENVIRONMENT,
            "compiler_arguments": COMPILER_ARGUMENTS,
            "c_includes": C_INCLUDES,
            "cxx_includes": CXX_INCLUDES,
            "compiler_unset": COMPILER_UNSET,
        }.items()
    ] + [
        c_strings(
            "args_" + str(i),
            ARGUMENTS.get(name, []),
        )
        for i, name in enumerate(PROGRAMS)
    ] + [
        c_strings(
            "environment_" + str(i),
            PROGRAM_ENVIRONMENT.get(name, []),
        )
        for i, name in enumerate(PROGRAMS)
    ] + ["static const struct profile profiles[] = {"] + [
        "{" + ", ".join([
            json.encode(name),
            json.encode("{root}/" + program),
            json.encode(ARGV0[name]) if name in ARGV0 else "NULL",
            "1" if name in COMPILERS else "0",
            "1" if COMPILERS.get(name) else "0",
            "args_" + str(i),
            "environment_" + str(i),
        ]) + "},"
        for i, (name, program) in enumerate(PROGRAMS.items())
    ] + [
        "};",
        "",
    ]),
)

filegroup(
    name = "launcher-source",
    srcs = {
        "launcher.c": "launcher.c",
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
    source_tree = ":launcher-source",
    toolchain = GCC + ":stage3-gcc",
)

c_binary(
    name = "launcher",
    objects = [":launcher.o"],
    output = "launcher",
    runtime = GCC + ":stage3-link-runtime",
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
    GCC_INCLUDE: GCC + ":compiler-headers",
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
    GCC_LIBEXEC + "/" + name: GCC + ":stage3-" + target
    for name, target in {
        "gcc": "xgcc",
        "g++": "g++",
        "cpp": "cpp",
        "gcov": "gcov",
        "cc1": "cc1",
        "cc1plus": "cc1plus",
    }.items()
} | {GCC_LIBEXEC + "/" + name: PREFIX + "binutils241:" + name for name in [
    "as",
    "ld",
]} | {
    "libexec/binutils/" + name: PREFIX + "binutils241:" + name
    for name in BINUTILS
} | {"bin/" + name: ":launcher" for name in BINUTILS + list(GCC_PROGRAMS)}

USERLAND_FILES = {"libexec/bootstrap/" + name: label for name, label in USER_PROGRAMS.items()} | {
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
    "share/licenses/" + package.removesuffix("-final"): PREFIX + package + ":installation[share/licenses/" + package.removesuffix("-final") + "]"
    for package in USERLAND
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
    "share/bootstrap/README": "README",
    "share/licenses/bootstrap/LICENSE": "LICENSE",
    "share/licenses/bootstrap/NOTICE": "NOTICE",
    "share/licenses/musl/COPYRIGHT": MUSL + ":source[COPYRIGHT]",
    "share/licenses/gcc/COPYING3": GCC + ":gcc-13.5.0[COPYING3]",
    "share/licenses/gcc/COPYING.RUNTIME": GCC + ":gcc-13.5.0[COPYING.RUNTIME]",
}

# The toolchain and the userland install on their own or together as all.
INSTALLATIONS = {
    "toolchain": TOOLCHAIN_FILES,
    "userland": USERLAND_FILES,
    "all": TOOLCHAIN_FILES | USERLAND_FILES,
}

[
    [
        write_file(
            name = name + "-manifest",
            content = "\n".join([path + "\t" + (files | COMMON_FILES)[path] for path in sorted(files | COMMON_FILES)]) + "\n",
        ),
        filegroup(
            name = name,
            srcs = files | COMMON_FILES | {"share/bootstrap/manifest.tsv": ":" + name + "-manifest"},
        ),
    ]
    for name, files in INSTALLATIONS.items()
]

# Each command runs from the complete installation, as in
# buck2 run cellar//bootstrap/stage1/installation:gcc -- hello.c.
[installed_tool(
    name = ("lbracket" if name == "[" else name),
    installation = ":all",
    path = "bin/" + name,
) for name in PROGRAMS]

filegroup(
    name = "acceptance-source",
    srcs = {name: "tests/" + name for name in [
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

# Each case of tests/acceptance.sh runs the installed programs with no host
# tools on PATH.
[
    [
        generate(
            name = "acceptance-" + name,
            args = [
                "--noprofile",
                "--norc",
                "source/acceptance.sh",
                name,
                "$(location :all)",
            ],
            chdir = True,
            directory = True,
            env = {
                "PATH": "/nonexistent-bootstrap-path",
                "TMPDIR": ".",
                "CELLAR_BOOTSTRAP_IDENTITY": "1",
                "TZ": "UTC0",
                "LC_ALL": "C.UTF-8",
            },
            files = ["passed"],
            source_tree = ":acceptance-source",
            tool = ":bash",
        ),
        result_test(
            name = "installed-" + name,
            result = ":acceptance-" + name + "[passed]",
        ),
    ]
    for name in [
        "versions",
        "compilation",
        "generators",
        "files-and-archives",
        "locate",
        "relocation",
    ]
]
