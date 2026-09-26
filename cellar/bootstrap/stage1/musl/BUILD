# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "ungz", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object", "link_runtime")
load("@cellar//bootstrap/stage1/tcc:defs.bzl", "tcc_toolchain")
load(":defs.bzl", "musl_pass")
load(":sources.bzl", "ARCH_SOURCES", "BASE_SOURCES", "CRT_SOURCES", "HEADER_FILES", "INTERNAL_HEADERS")

# TCC has no complex types. The functions that use musl's Unicode and iconv
# tables wait for the regenerated tables, which the restored pass adds.
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

# TCC's assembler lacks x87 instructions that musl's native math uses, so the
# passes take the generic C math. They keep the native startup, TLS, syscall,
# setjmp and string assembly.
NATIVE_SOURCES = [path for path in ARCH_SOURCES if not path.startswith("src/math/")]

REPLACED = [path.replace("/x86_64/", "/").rsplit(".", 1)[0] + ".c" for path in NATIVE_SOURCES]

LIBC_SOURCES = sorted([path for path in BASE_SOURCES if path not in REPLACED + REDUCED_OMISSIONS and not path.startswith("src/complex/")] + NATIVE_SOURCES)

RESTORED_SOURCES = sorted(LIBC_SOURCES + REDUCED_OMISSIONS)

SOURCE_FILES = HEADER_FILES + [path for path in INTERNAL_HEADERS if path not in GENERATED_TABLES] + LIBC_SOURCES + CRT_SOURCES

download_file(
    name = "musl-1.1.24.tar.gz",
    hash = "1370c9a812b2cf2a7d92802510cca0058cc37e66a7bedd70051f0a34015022a3",
    size_bytes = 1024988,
    urls = ["https://musl.libc.org/releases/musl-1.1.24.tar.gz"],
)

ungz(
    name = "musl.tar",
    input = ":musl-1.1.24.tar.gz",
    ungz = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name = "musl-1.1.24",
    # Generated headers are projected only for table-regeneration tests.
    files = SOURCE_FILES + REDUCED_OMISSIONS + GENERATED_TABLES + [path for path in ARCH_SOURCES if path not in NATIVE_SOURCES],
    input = ":musl.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

[
    exact_patch(
        name = name,
        src = ":musl-1.1.24[" + path + "]",
        output = name,
        patch = ":patches/" + name + ".patch",
    )
    for name, path in [
        ("alltypes", "arch/x86_64/bits/alltypes.h.in"),
        ("stdarg", "include/stdarg.h"),
        ("syscalls", "arch/x86_64/syscall_arch.h"),
        ("sigsetjmp", "src/signal/x86_64/sigsetjmp.s"),
        ("madvise", "src/malloc/malloc.c"),
    ]
]

[export_file(name = path) for path in glob([
    "patches/*.patch",
    "tests/*.c",
])]

generate(
    name = "alltypes.h",
    args = [
        "-f",
        "$(location :musl-1.1.24[tools/mkalltypes.sed])",
        "$(location :alltypes)",
        "$(location :musl-1.1.24[include/alltypes.h.in])",
    ],
    capture = True,
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
    capture = True,
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

TCC_MUSL = "cellar//bootstrap/stage1/tcc-musl"

# Release TCC linked with Mes libc compiles the initial pass. It sees only the
# generated musl headers and passes no sysroot.
tcc_toolchain(
    name = "predecessor",
    cflags = ["-nostdinc"],
    execution_runtime = TCC + ":runtime-mes0",
    tcc = TCC + ":tcc-mes1",
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

musl_pass(
    name = "initial",
    libtcc1 = TCC + ":mes1-libtcc1.a",
    sources = LIBC_SOURCES,
    toolchain = ":predecessor",
    tree = ":source",
)

# musl-linked TCC rebuilds the reduced libc, then the restored one.
tcc_toolchain(
    name = "rebuilt-predecessor",
    cflags = ["-nostdinc"],
    execution_runtime = ":runtime-initial",
    sysroot = TCC_MUSL + ":runtime-musl1",
    tcc = TCC_MUSL + ":tcc-musl1",
)

musl_pass(
    name = "rebuilt",
    libtcc1 = TCC_MUSL + ":musl1-libtcc1.a",
    sources = LIBC_SOURCES,
    toolchain = ":rebuilt-predecessor",
    tree = ":source",
)

tcc_toolchain(
    name = "restored-predecessor",
    cflags = ["-nostdinc"],
    execution_runtime = ":runtime-rebuilt",
    sysroot = TCC_MUSL + ":runtime-musl2",
    tcc = TCC_MUSL + ":tcc-musl2",
)

musl_pass(
    name = "restored",
    extra_tests = ["unicode"],
    libtcc1 = TCC_MUSL + ":musl2-libtcc1.a",
    sources = RESTORED_SOURCES,
    toolchain = ":restored-predecessor",
    tree = ":source-restored",
)

# The runnable musl TCC: the self-hosted musl-linked TCC with the restored
# libc. It marks the musl headers as system headers.
tcc_toolchain(
    name = "tcc",
    cflags = [
        "-nostdinc",
        "-isystem",
        "$(location :headers)",
    ],
    execution_runtime = ":runtime-rebuilt",
    sysroot = ":runtime-restored",
    tcc = TCC_MUSL + ":tcc-musl2",
)

# What a program that the tcc compiler links gets around its own objects:
# the same objects and libraries as restored-link-runtime.
link_runtime(
    name = "tcc-link-runtime",
    end_objects = [":restored-crtn.o"],
    libraries = [
        ":restored-libc.a",
        TCC_MUSL + ":musl2-libtcc1.a",
        ":restored-libc.a",
    ],
    start_objects = [
        ":restored-crt1.o",
        ":restored-crti.o",
    ],
)

filegroup(
    name = "test-headers",
    srcs = {"regex.h": "tests/include/regex.h"},
)

c_object(
    name = "include-order.o",
    src = "tests/include-order.c",
    headers = [":test-headers"],
    includes = [":test-headers"],
    object_name = "priority.o",
    toolchain = ":tcc",
)

c_binary(
    name = "include-order-program",
    objects = [":include-order.o"],
    runtime = ":tcc-link-runtime",
    toolchain = ":tcc",
)

command_test(
    name = "header-search-order",
    tool = ":include-order-program",
)

export_file(name = "runtime/syscall.S")
