# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "ungz", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "bootstrap_artifact", "c_binary", "c_library", "c_object", "compiler", "sysroot")
load(":sources.bzl", "ARCH_SOURCES", "BASE_C_SOURCES", "CRT_SOURCES", "INTERNAL_HEADERS", "PUBLIC_HEADERS")

GCC = "cellar//bootstrap/stage1/gcc40"

OLD_MUSL = "cellar//bootstrap/stage1/musl"

TABLES = "cellar//bootstrap/stage1/musl-tables"

BINUTILS = "cellar//bootstrap/stage1/binutils"

PREDECESSOR = GCC + ":gcc"

ICONV_TABLES = [
    "big5",
    "codepages",
    "gb18030",
    "hkscs",
    "jis0208",
    "ksc",
    "legacychars",
    "revjis",
]

CTYPE_TABLES = [
    "alpha",
    "punct",
    "nonspacing",
    "wide",
    "casemap",
]

GENERATED_TABLES = ["src/ctype/" + name + ".h" for name in CTYPE_TABLES] + ["src/locale/" + name + ".h" for name in ICONV_TABLES]

REPLACED = [path.replace("/x86_64/", "/").rsplit(".", 1)[0] + ".c" for path in ARCH_SOURCES]

LIBC_SOURCES = sorted([path for path in BASE_C_SOURCES if path not in REPLACED] + ARCH_SOURCES)

SOURCE_FILES = PUBLIC_HEADERS + [path for path in INTERNAL_HEADERS if path not in GENERATED_TABLES] + LIBC_SOURCES + CRT_SOURCES + [
    "arch/x86_64/bits/alltypes.h.in",
    "include/alltypes.h.in",
    "arch/x86_64/bits/syscall.h.in",
    "tools/mkalltypes.sed",
    # Included by the native dispatch translation units.
    "src/math/fma.c",
    "src/math/fmaf.c",
    "COPYRIGHT",
]

download_file(
    name = "musl-1.2.5.tar.gz",
    hash = "a9a118bbe84d8764da0ea0d28b3ab3fae8477fc7e4085d90102b8596fc7c75e4",
    size_bytes = 1080786,
    urls = ["https://musl.libc.org/releases/musl-1.2.5.tar.gz"],
)

ungz(
    name = "musl.tar",
    input = ":musl-1.2.5.tar.gz",
    ungz = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name = "musl-1.2.5",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    # Published tables are projected only for regeneration comparisons.
    files = SOURCE_FILES + GENERATED_TABLES,
    input = ":musl.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

generate(
    name = "alltypes.h",
    args = [
        "-f",
        "$(location :musl-1.2.5[tools/mkalltypes.sed])",
        "$(location :musl-1.2.5[arch/x86_64/bits/alltypes.h.in])",
        "$(location :musl-1.2.5[include/alltypes.h.in])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

generate(
    name = "syscall.h",
    args = [
        "-n",
        "-e",
        "p;s/__NR_/SYS_/p",
        "$(location :musl-1.2.5[arch/x86_64/bits/syscall.h.in])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

write_file(
    name = "version.h",
    content = '#define VERSION "1.2.5"\n',
)

filegroup(
    name = "headers",
    srcs = {p.removeprefix("include/"): ":musl-1.2.5[" + p + "]" for p in PUBLIC_HEADERS if p.startswith("include/")} |
           {p.removeprefix("arch/generic/"): ":musl-1.2.5[" + p + "]" for p in PUBLIC_HEADERS if p.startswith("arch/generic/")} |
           {p.removeprefix("arch/x86_64/"): ":musl-1.2.5[" + p + "]" for p in PUBLIC_HEADERS if p.startswith("arch/x86_64/")} |
           {
               "bits/alltypes.h": ":alltypes.h",
               "bits/syscall.h": ":syscall.h",
           },
)

TABLE_REVISION = "78b213a868553b1154ee9627c96ff1f14a9a3b1b"

TABLE_FILES = [
    "README",
    "ctype/arrayify.c",
    "ctype/gen_ctype.c",
    "ctype/gen_wide.c",
    "ctype/gen_nonspacing.c",
    "ctype/gen_casemap.c",
    "ctype/data/UnicodeData.txt",
    "ctype/data/DerivedCoreProperties.txt",
    "ctype/data/EastAsianWidth.txt",
]

download_file(
    name = "musl-chartable-tools.tar.gz",
    hash = "bb52d7c11b663c2d1c5957fd862758d1da7e65b53c0a8ecfb9110d02c04badb6",
    size_bytes = 7068942,
    urls = ["https://codeload.github.com/richfelker/musl-chartable-tools/tar.gz/" + TABLE_REVISION],
)

ungz(
    name = "tables.tar",
    input = ":musl-chartable-tools.tar.gz",
    ungz = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name = "musl-chartable-tools-" + TABLE_REVISION,
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = TABLE_FILES,
    input = ":tables.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

filegroup(
    name = "table-source",
    srcs = {p: ":musl-chartable-tools-" + TABLE_REVISION + "[" + p + "]" for p in TABLE_FILES},
)

PREDECESSOR_CRT = [
    OLD_MUSL + ":gnu-crt1.o",
    OLD_MUSL + ":gnu-crti.o",
    GCC + ":crtbeginT.o",
]

PREDECESSOR_END = [
    GCC + ":crtend.o",
    OLD_MUSL + ":gnu-crtn.o",
]

PREDECESSOR_LIBS = [
    GCC + ":libgcc.a",
    OLD_MUSL + ":gnu-libc.a",
    GCC + ":libgcc.a",
    OLD_MUSL + ":gnu-libc.a",
]

[
    [
        c_object(
            name = name + ".o",
            src = ":table-source[ctype/" + name + ".c]",
            defines = ["_GNU_SOURCE=1"],
            flags = [
                "-O2",
                "-std=c99",
                "-Werror",
            ],
            object_name = name + ".o",
            toolchain = PREDECESSOR,
        ),
        c_binary(
            name = name,
            end_objects = PREDECESSOR_END,
            libraries = PREDECESSOR_LIBS,
            objects = PREDECESSOR_CRT + [":" + name + ".o"],
            output = name,
            toolchain = PREDECESSOR,
        ),
    ]
    for name in [
        "gen_ctype",
        "gen_wide",
        "gen_nonspacing",
        "gen_casemap",
        "arrayify",
    ]
]

[
    [
        generate(
            name = name + "-values",
            args = args,
            capture = "cellar//bootstrap/stage1/tools:capture",
            inputs = [":table-source"],
            tool = ":" + tool,
            working_directory = ":table-source[ctype]",
        ),
        generate(
            name = name + ".h",
            capture = "cellar//bootstrap/stage1/tools:capture",
            stdin = ":" + name + "-values",
            tool = ":arrayify",
        ),
        command_test(
            name = "table-" + name,
            args = [
                "numbers",
                "$(location :" + name + ".h)",
                "$(location :musl-1.2.5[src/ctype/" + name + ".h])",
            ],
            tool = TABLES + ":compare-tables",
        ),
    ]
    for name, tool, args in [
        (
            "alpha",
            "gen_ctype",
            ["a"],
        ),
        (
            "punct",
            "gen_ctype",
            ["p"],
        ),
        ("wide", "gen_wide", []),
        ("nonspacing", "gen_nonspacing", []),
    ]
]

generate(
    name = "casemap.h",
    capture = "cellar//bootstrap/stage1/tools:capture",
    stdin = ":table-source[ctype/data/UnicodeData.txt]",
    tool = ":gen_casemap",
)

command_test(
    name = "table-casemap",
    args = [
        "$(location :casemap.h)",
        "$(location :musl-1.2.5[src/ctype/casemap.h])",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

[
    command_test(
        name = "table-" + name,
        args = [
            "strings" if name == "codepages" else "numbers",
            "$(location " + TABLES + ":" + name + ".h)",
            "$(location :musl-1.2.5[src/locale/" + name + ".h])",
        ],
        tool = TABLES + ":compare-tables",
    )
    for name in ICONV_TABLES
]

filegroup(
    name = "source",
    srcs = {p: ":musl-1.2.5[" + p + "]" for p in SOURCE_FILES if not p.startswith("include/") and p not in GENERATED_TABLES} |
           {
               "include": ":headers",
               "src/internal/version.h": ":version.h",
           } |
           {"src/ctype/" + name + ".h": ":" + name + ".h" for name in CTYPE_TABLES} |
           {"src/locale/" + name + ".h": TABLES + ":" + name + ".h" for name in ICONV_TABLES},
)

# Compile against only the newly generated musl headers. The test executable
# still runs on the predecessor's compatible native x86_64 libc.
configured_tool(
    name = "header-driver",
    args = [
        "-B$(location " + GCC + ":native-tools)/",
        "-nostdinc",
        "-isystem",
        "$(location :headers)",
    ],
    env = {"TMPDIR": "."},
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = GCC + ":xgcc",
)

compiler(
    name = "header-compiler",
    abi = "x86_64-sysv",
    archive_flags = ["crsD"],
    archive_format = "ar",
    archiver = BINUTILS + ":ar",
    cflags = [
        "-g0",
        "-frandom-seed=bootstrap",
    ],
    compiler = ":header-driver",
    execution_runtime = OLD_MUSL + ":runtime-gnu",
    family = "gcc",
    ldflags = ["-static"],
    linker = BINUTILS + ":ld",
    object_format = "elf64-x86-64",
    stage = "gcc-4.0.4-musl-1.2.5-headers",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
)

c_object(
    name = "headers.o",
    src = OLD_MUSL + ":test-source[tests/headers.c]",
    toolchain = ":header-compiler",
)

c_binary(
    name = "headers-program",
    end_objects = PREDECESSOR_END,
    libraries = PREDECESSOR_LIBS,
    objects = PREDECESSOR_CRT + [":headers.o"],
    toolchain = PREDECESSOR,
)

command_test(
    name = "native-headers",
    tool = ":headers-program",
)

# Native static musl configuration for GCC 4.0.4. This compiler has no stack
# protector or loop-distribute-patterns pass; those later options are omitted.
LIBC_FLAGS = [
    "-Os",
    "-std=c99",
    # GCC 4.0 predates the GNU C anonymous-union default.
    "-fms-extensions",
    "-ffreestanding",
    "-fno-strict-aliasing",
    "-frounding-math",
    "-fomit-frame-pointer",
    "-fno-unwind-tables",
    "-fno-asynchronous-unwind-tables",
    "-ffunction-sections",
    "-fdata-sections",
    "-fno-align-jumps",
    "-fno-align-functions",
    "-fno-align-loops",
    "-fno-align-labels",
    "-fno-reorder-blocks",
    "-fno-prefetch-loop-arrays",
    "-fno-tree-ch",
    "-Wa,--noexecstack",
    "-Werror",
]

LIBC_INCLUDES = [
    ":source[arch/x86_64]",
    ":source[arch/generic]",
    ":source[src/include]",
    ":source[src/internal]",
    ":source[include]",
]

[
    c_object(
        name = "libc-{}.o".format(i),
        src = ":source[" + path + "]",
        defines = ["_XOPEN_SOURCE=700"],
        flags = LIBC_FLAGS,
        headers = [":source"],
        includes = LIBC_INCLUDES,
        object_name = "m{}.o".format(i),
        toolchain = ":header-compiler",
    ) if not path.endswith(".s") else [
        generate(
            name = "asm-{}".format(i),
            args = [
                "--64",
                "--noexecstack",
                "$(location :source[" + path + "])",
                "-o",
            ],
            output = "m{}.o".format(i),
            tool = BINUTILS + ":as",
        ),
        bootstrap_artifact(
            name = "libc-{}.o".format(i),
            src = ":asm-{}".format(i),
            abi = "x86_64-sysv",
            kind = "object",
            object_format = "elf64-x86-64",
        ),
    ]
    for i, path in enumerate(LIBC_SOURCES)
]

c_library(
    name = "libc.a",
    objects = [":libc-{}.o".format(i) for i in range(len(LIBC_SOURCES))],
    output = "libc.a",
    toolchain = ":header-compiler",
)

[
    c_object(
        name = path.rsplit("/", 1)[1].rsplit(".", 1)[0] + ".o",
        src = ":source[" + path + "]",
        defines = [
            "CRT=1",
            "_XOPEN_SOURCE=700",
        ],
        flags = LIBC_FLAGS,
        headers = [":source"],
        includes = LIBC_INCLUDES,
        object_name = path.rsplit("/", 1)[1].rsplit(".", 1)[0] + ".o",
        toolchain = ":header-compiler",
    ) if path.endswith(".c") else [
        generate(
            name = path.rsplit("/", 1)[1] + "-asm",
            args = [
                "--64",
                "--noexecstack",
                "$(location :source[" + path + "])",
                "-o",
            ],
            output = path.rsplit("/", 1)[1].rsplit(".", 1)[0] + ".o",
            tool = BINUTILS + ":as",
        ),
        bootstrap_artifact(
            name = path.rsplit("/", 1)[1].rsplit(".", 1)[0] + ".o",
            src = ":" + path.rsplit("/", 1)[1] + "-asm",
            abi = "x86_64-sysv",
            kind = "object",
            object_format = "elf64-x86-64",
        ),
    ]
    for path in CRT_SOURCES
]

COMPAT_LIBRARIES = [
    "m",
    "rt",
    "pthread",
    "crypt",
    "util",
    "xnet",
    "resolv",
    "dl",
]

[
    c_library(
        name = "lib" + name + ".a",
        objects = [],
        output = "lib" + name + ".a",
        toolchain = ":header-compiler",
    )
    for name in COMPAT_LIBRARIES
]

sysroot(
    name = "runtime",
    abi = "x86_64-sysv",
    files = {"include": ":headers"},
    libraries = {"lib/lib" + name + ".a": ":lib" + name + ".a" for name in ["c"] + COMPAT_LIBRARIES} |
                {"lib/lib" + name + ".a": GCC + ":lib" + name + ".a" for name in [
                    "gcc",
                    "gcov",
                ]},
    object_format = "elf64-x86-64",
    objects = {"lib/" + name + ".o": ":" + name + ".o" for name in [
                  "crt1",
                  "crti",
                  "crtn",
              ]} |
              {"lib/" + name + ".o": GCC + ":" + name + ".o" for name in [
                  "crtbeginT",
                  "crtend",
              ]},
)

configured_tool(
    name = "gcc-command",
    args = [
        "-B$(location " + GCC + ":native-tools)/",
        "-B$(location :runtime)/lib/",
        "-nostdinc",
        "-isystem",
        "$(location " + GCC + ":compiler-headers)",
        "-isystem",
        "$(location :headers)",
    ],
    env = {"TMPDIR": "."},
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = GCC + ":xgcc",
)

compiler(
    name = "gcc",
    abi = "x86_64-sysv",
    archive_flags = ["crsD"],
    archive_format = "ar",
    archiver = BINUTILS + ":ar",
    cflags = [
        "-g0",
        "-frandom-seed=bootstrap",
    ],
    compiler = ":gcc-command",
    execution_runtime = OLD_MUSL + ":runtime-gnu",
    family = "gcc",
    ldflags = ["-static"],
    linker = BINUTILS + ":ld",
    object_format = "elf64-x86-64",
    stage = "gcc-4.0.4-with-full-musl-1.2.5",
    sysroot = ":runtime",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
)

filegroup(
    name = "installation",
    srcs = {
               "include": ":headers",
               "share/licenses/musl/COPYRIGHT": ":musl-1.2.5[COPYRIGHT]",
           } |
           {"lib/" + name + ".o": ":" + name + ".o" for name in [
               "crt1",
               "crti",
               "crtn",
           ]} |
           {"lib/lib" + name + ".a": ":lib" + name + ".a" for name in ["c"] + COMPAT_LIBRARIES},
)

[export_file(name = path) for path in glob(["tests/*.c"])]

[
    [
        generate(
            name = name + "-program",
            args = [
                "-O2",
                "-std=gnu99",
                "-fms-extensions",
                "-Werror",
                "-frandom-seed=bootstrap",
                "$(location " + source + ")",
                "-o",
                "program",
            ],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            files = ["program"],
            tool = ":gcc",
        ),
        command_test(
            name = "native-" + name,
            args = [
                "0",
                "$(location :" + name + "-program[program])",
            ] + ([
                "startup",
                "ok",
            ] if name == "runtime" else []),
            env = {"BOOTSTRAP_TEST": "present"},
            tool = "cellar//bootstrap/stage1/tools:expect-exit",
        ),
    ]
    for name, source in [(
                            name,
                            ":tests/" + name + ".c",
                        ) for name in [
                            "complex",
                            "anonymous-union",
                            "allocator",
                            "pthread",
                        ]] +
                        [(
                            name,
                            OLD_MUSL + ":test-source[tests/" + name + ".c]",
                        ) for name in [
                            "runtime",
                            "threads",
                            "fenv",
                            "native-math",
                            "unicode",
                            "syscalls",
                        ]]
]
