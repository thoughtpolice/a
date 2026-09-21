# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "ungz", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object", "compiler", "sysroot")
load(":sources.bzl", "ARCH_SOURCES", "BASE_SOURCES", "CRT_SOURCES", "HEADER_FILES", "INTERNAL_HEADERS")

# The first compiler has no complex support. Unicode-derived functions are
# restored after their table generators can run against musl.
REDUCED_OMISSIONS = [
    "src/ctype/iswalpha.c",
    "src/ctype/iswalnum.c",
    "src/ctype/iswctype.c",
    "src/ctype/iswpunct.c",
    "src/ctype/iswlower.c",
    "src/ctype/iswupper.c",
    "src/ctype/towctrans.c",
    "src/ctype/wctrans.c",
    "src/ctype/wcwidth.c",
    "src/ctype/wcswidth.c",
    "src/locale/iconv.c",
    "src/locale/iconv_close.c",
]

GENERATED_TABLES = [
    "src/ctype/alpha.h",
    "src/ctype/punct.h",
    "src/ctype/nonspacing.h",
    "src/ctype/wide.h",
    "src/locale/big5.h",
    "src/locale/codepages.h",
    "src/locale/gb18030.h",
    "src/locale/hkscs.h",
    "src/locale/jis0208.h",
    "src/locale/ksc.h",
    "src/locale/legacychars.h",
    "src/locale/revjis.h",
]

# Use the upstream generic C math implementations until GNU assembly is
# available; keep native startup, TLS, syscalls, setjmp and string assembly.
NATIVE_SOURCES = [path for path in ARCH_SOURCES if not path.startswith("src/math/")]

REPLACED = [path.replace("/x86_64/", "/").rsplit(".", 1)[0] + ".c" for path in NATIVE_SOURCES]

LIBC_SOURCES = sorted([path for path in BASE_SOURCES if path not in REPLACED + REDUCED_OMISSIONS and not path.startswith("src/complex/")] + NATIVE_SOURCES)

RESTORED_SOURCES = sorted(LIBC_SOURCES + REDUCED_OMISSIONS)

SOURCE_FILES = HEADER_FILES + [path for path in INTERNAL_HEADERS if path not in GENERATED_TABLES] + LIBC_SOURCES + CRT_SOURCES

download_file(
    name = "musl-1.1.24.tar.gz",
    hash = "1370c9a812b2cf2a7d92802510cca0058cc37e66a7bedd70051f0a34015022a3",
    urls = ["https://musl.libc.org/releases/musl-1.1.24.tar.gz"],
)

ungz(
    name = "musl.tar",
    input = ":musl-1.1.24.tar.gz",
    ungz = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name = "musl-1.1.24",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    # Generated headers are projected only for table-regeneration tests.
    files = SOURCE_FILES + REDUCED_OMISSIONS + GENERATED_TABLES,
    input = ":musl.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

[
    generate(
        name = name,
        args = [
            "$(location :musl-1.1.24[" + path + "])",
            "$(location :patches/" + name + ".before)",
            "$(location :patches/" + name + ".after)",
        ],
        output = name,
        tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
    )
    for name, path in [
        ("alltypes", "arch/x86_64/bits/alltypes.h.in"),
        ("stdarg", "include/stdarg.h"),
        ("syscalls", "arch/x86_64/syscall_arch.h"),
        ("sigsetjmp", "src/signal/x86_64/sigsetjmp.s"),
        ("madvise", "src/malloc/malloc.c"),
    ]
]

[export_file(name = path) for path in glob(["patches/*"])]

generate(
    name = "alltypes.h",
    args = [
        "-f",
        "$(location :musl-1.1.24[tools/mkalltypes.sed])",
        "$(location :alltypes)",
        "$(location :musl-1.1.24[include/alltypes.h.in])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

# Print each original __NR_ definition, followed by the public SYS_ alias.
generate(
    name = "syscall.h",
    args = [
        "-n",
        "-e",
        "p;s/__NR_/SYS_/p",
        "$(location :musl-1.1.24[arch/x86_64/bits/syscall.h.in])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

write_file(
    name = "version.h",
    content = '#define VERSION "1.1.24"\n',
)

PUBLIC_HEADERS = {path.removeprefix("include/"): ":musl-1.1.24[{}]".format(path) for path in HEADER_FILES if path.startswith("include/") and path.endswith(".h")}

GENERIC_BITS = {path.removeprefix("arch/generic/"): ":musl-1.1.24[{}]".format(path) for path in HEADER_FILES if path.startswith("arch/generic/bits/") and path.endswith(".h")}

NATIVE_BITS = {path.removeprefix("arch/x86_64/"): ":musl-1.1.24[{}]".format(path) for path in HEADER_FILES if path.startswith("arch/x86_64/bits/") and path.endswith(".h")}

filegroup(
    name = "headers",
    srcs = PUBLIC_HEADERS | GENERIC_BITS | NATIVE_BITS | {
        "bits/alltypes.h": ":alltypes.h",
        "bits/syscall.h": ":syscall.h",
        "stdarg.h": ":stdarg",
    },
)

TCC = "cellar//bootstrap/stage1/tcc-release"

# This compiler executes with Mes but consumes only the newly generated musl
# headers. Its output runtime will become musl after the next acceptance gate.
compiler(
    name = "predecessor",
    abi = "x86_64-sysv",
    archive_flags = [
        "-ar",
        "cr",
    ],
    archive_format = "ar",
    archiver = TCC + ":tcc-mes1",
    cflags = ["-nostdinc"],
    compiler = TCC + ":tcc-mes1",
    execution_runtime = TCC + ":runtime-mes0",
    family = "tcc",
    ldflags = [
        "-nostdlib",
        "-static",
    ],
    object_format = "elf64-x86-64",
    stage = "first-musl",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
)

c_object(
    name = "headers.o",
    src = "tests/headers.c",
    headers = [":headers"],
    includes = [":headers"],
    object_name = "headers.o",
    toolchain = ":predecessor",
)

c_binary(
    name = "headers-program",
    libraries = [
        TCC + ":mes1-libtcc1.a",
        TCC + ":mes0-libc.a",
    ],
    objects = [
        TCC + ":mes0-crt1.o",
        ":headers.o",
    ],
    toolchain = ":predecessor",
)

command_test(
    name = "native-headers",
    tool = ":headers-program",
)

filegroup(
    name = "test-source",
    srcs = {path: path for path in glob(["tests/*.c"])},
)

PREPARED_SOURCE = {path: ":musl-1.1.24[{}]".format(path) for path in SOURCE_FILES} | {
    "include/bits/alltypes.h": ":alltypes.h",
    "include/bits/syscall.h": ":syscall.h",
    "include/stdarg.h": ":stdarg",
    "src/internal/version.h": ":version.h",
    "arch/x86_64/syscall_arch.h": ":syscalls",
    "src/signal/x86_64/sigsetjmp.s": ":sigsetjmp",
    "src/malloc/malloc.c": ":madvise",
}

filegroup(
    name = "source",
    srcs = PREPARED_SOURCE,
)

filegroup(
    name = "source-restored",
    srcs = PREPARED_SOURCE | {
        path: ":musl-1.1.24[" + path + "]"
        for path in REDUCED_OMISSIONS
    } | {
        path: "cellar//bootstrap/stage1/musl-tables:generated[" + path.removeprefix("src/") + "]"
        for path in GENERATED_TABLES
    },
)

compiler(
    name = "rebuilt-predecessor",
    abi = "x86_64-sysv",
    archive_flags = [
        "-ar",
        "cr",
    ],
    archive_format = "ar",
    archiver = "cellar//bootstrap/stage1/tcc-musl:tcc-musl1",
    cflags = ["-nostdinc"],
    compiler = "cellar//bootstrap/stage1/tcc-musl:tcc-musl1",
    execution_runtime = ":runtime-initial",
    family = "tcc",
    ldflags = [
        "-nostdlib",
        "-static",
    ],
    object_format = "elf64-x86-64",
    stage = "musl-rebuilt",
    sysroot = "cellar//bootstrap/stage1/tcc-musl:runtime-musl1",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
)

compiler(
    name = "restored-predecessor",
    abi = "x86_64-sysv",
    archive_flags = [
        "-ar",
        "cr",
    ],
    archive_format = "ar",
    archiver = "cellar//bootstrap/stage1/tcc-musl:tcc-musl2",
    cflags = ["-nostdinc"],
    compiler = "cellar//bootstrap/stage1/tcc-musl:tcc-musl2",
    execution_runtime = ":runtime-rebuilt",
    family = "tcc",
    ldflags = [
        "-nostdlib",
        "-static",
    ],
    object_format = "elf64-x86-64",
    stage = "musl-restored",
    sysroot = "cellar//bootstrap/stage1/tcc-musl:runtime-musl2",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
)

[
    [
        [
            c_object(
                name = stage + "-libc-{}.o".format(i),
                src = tree + "[{}]".format(path),
                defines = ["_XOPEN_SOURCE=700"],
                flags = [
                    "-std=c99",
                    "-ffreestanding",
                    "-Werror",
                ],
                headers = [tree],
                # do not sort: native and internal headers override public headers.
                includes = [
                    tree + "[arch/x86_64]",
                    tree + "[arch/generic]",
                    tree + "[src/include]",
                    tree + "[src/internal]",
                    tree + "[include]",
                ],
                object_name = "m{}.o".format(i),
                toolchain = tc,
            )
            for i, path in enumerate(sources)
        ],
        c_object(
            name = stage + "-syscall.o",
            src = "runtime/syscall.S",
            object_name = "syscall.o",
            toolchain = tc,
        ),
        c_library(
            name = stage + "-libc.a",
            objects = [":" + stage + "-libc-{}.o".format(i) for i in range(len(sources))] + [":" + stage + "-syscall.o"],
            output = "libc.a",
            toolchain = tc,
        ),
        [
            c_object(
                name = stage + "-" + path.rsplit("/", 1)[1].rsplit(".", 1)[0] + ".o",
                src = tree + "[{}]".format(path),
                defines = [
                    "CRT=1",
                    "_XOPEN_SOURCE=700",
                ],
                headers = [tree],
                # do not sort
                includes = [
                    tree + "[arch/x86_64]",
                    tree + "[arch/generic]",
                    tree + "[src/include]",
                    tree + "[src/internal]",
                    tree + "[include]",
                ],
                object_name = path.rsplit("/", 1)[1].rsplit(".", 1)[0] + ".o",
                toolchain = tc,
            )
            for path in CRT_SOURCES
        ],
        [
            c_library(
                name = stage + "-lib" + name + ".a",
                objects = [],
                output = "lib" + name + ".a",
                toolchain = tc,
            )
            for name in [
                "m",
                "rt",
                "pthread",
                "crypt",
                "util",
                "xnet",
                "resolv",
                "dl",
            ]
        ],
        sysroot(
            name = "runtime-" + stage,
            abi = "x86_64-sysv",
            files = {"include": ":headers"},
            libraries = {"lib/lib" + name + ".a": ":" + stage + "-lib" + name + ".a" for name in [
                "c",
                "m",
                "rt",
                "pthread",
                "crypt",
                "util",
                "xnet",
                "resolv",
                "dl",
            ]} | {"lib/libtcc1.a": support_library},
            object_format = "elf64-x86-64",
            objects = {"lib/" + name + ".o": ":" + stage + "-" + name + ".o" for name in [
                "crt1",
                "crti",
                "crtn",
            ]},
        ),
        c_object(
            name = stage + "-runtime-test.o",
            src = "tests/runtime.c",
            headers = [":headers"],
            includes = [":headers"],
            object_name = "runtime.o",
            toolchain = tc,
        ),
        c_binary(
            name = stage + "-runtime-program",
            libraries = [
                ":" + stage + "-libc.a",
                support_library,
                ":" + stage + "-libc.a",
            ],
            objects = [
                ":" + stage + "-crt1.o",
                ":" + stage + "-crti.o",
                ":" + stage + "-runtime-test.o",
                ":" + stage + "-crtn.o",
            ],
            toolchain = tc,
        ),
        command_test(
            name = stage + "-runtime",
            args = [
                "startup",
                "ok",
            ],
            env = {"BOOTSTRAP_TEST": "present"},
            tool = ":" + stage + "-runtime-program",
        ),
        [
            [
                c_object(
                    name = stage + "-" + name + "-test.o",
                    src = "tests/" + name + ".c",
                    headers = [":headers"],
                    includes = [":headers"],
                    object_name = name + ".o",
                    toolchain = tc,
                ),
                c_binary(
                    name = stage + "-" + name + "-program",
                    libraries = [
                        ":" + stage + "-libc.a",
                        support_library,
                        ":" + stage + "-libc.a",
                    ],
                    objects = [
                        ":" + stage + "-crt1.o",
                        ":" + stage + "-crti.o",
                        ":" + stage + "-" + name + "-test.o",
                        ":" + stage + "-crtn.o",
                    ],
                    toolchain = tc,
                ),
                command_test(
                    name = stage + "-" + name,
                    tool = ":" + stage + "-" + name + "-program",
                ),
            ]
            for name in [
                "threads",
                "fenv",
                "syscalls",
            ] + (["unicode"] if stage == "restored" else [])
        ],
    ]
    for stage, tc, support_library, sources, tree in [
        (
            "initial",
            ":predecessor",
            TCC + ":mes1-libtcc1.a",
            LIBC_SOURCES,
            ":source",
        ),
        ("rebuilt", ":rebuilt-predecessor", "cellar//bootstrap/stage1/tcc-musl:musl1-libtcc1.a", LIBC_SOURCES, ":source"),
        ("restored", ":restored-predecessor", "cellar//bootstrap/stage1/tcc-musl:musl2-libtcc1.a", RESTORED_SOURCES, ":source-restored"),
    ]
]

compiler(
    name = "tcc",
    abi = "x86_64-sysv",
    archive_flags = [
        "-ar",
        "cr",
    ],
    archive_format = "ar",
    archiver = "cellar//bootstrap/stage1/tcc-musl:tcc-musl2",
    cflags = [
        "-nostdinc",
        "-I",
        "$(location :headers)",
    ],
    compiler = "cellar//bootstrap/stage1/tcc-musl:tcc-musl2",
    execution_runtime = ":runtime-rebuilt",
    family = "tcc",
    ldflags = [
        "-nostdlib",
        "-static",
    ],
    object_format = "elf64-x86-64",
    stage = "musl-restored",
    sysroot = ":runtime-restored",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
)
