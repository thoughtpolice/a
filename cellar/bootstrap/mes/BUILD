# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "compare_test", "configured_tool")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "replace", "ungz", "untar", "write_file")
load(":defs.bzl", "M1", "M2_Planet", "blood_elf", "hex2", "mescc_build_lib", "mescc_build_mes", "mescc_compile", "mescc_test")
load(":manifest.bzl", "PREPARED_FILES")
load(":sources.bzl", "LIBC_MINI_SOURCES", "LIBC_SOURCES", "LIBC_TCC_SOURCES", "LIBMESCC_SOURCES", "MES_SOURCES")

VERSION = "0.27"

# Mes's name for the architecture in its source tree.
MES_CPU = "x86_64"

TOOLS = "cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins"

TOOLS_EXTRA = "cellar//bootstrap/stage0-posix/mescc-tools-extra"

NYACC = "cellar//bootstrap/nyacc:modules"

# --- Download and extract ---

download_file(
    name = "mes-{}.tar.gz".format(VERSION),
    hash = "033ee656d98cfc04a826eab27eed6e6a276d15bbb980a7cd71d00f30227aaaa8",
    urls = ["https://mirrors.kernel.org/gnu/mes/mes-{}.tar.gz".format(VERSION)],
)

ungz(
    name = "mes-{}.tar".format(VERSION),
    input = ":mes-{}.tar.gz".format(VERSION),
    ungz = TOOLS_EXTRA + ":ungz",
)

untar(
    name = "mes-{}".format(VERSION),
    files = PREPARED_FILES + ["scripts/mescc.scm.in"],
    input = ":mes-{}.tar".format(VERSION),
    untar = TOOLS_EXTRA + ":untar",
)

write_file(
    name = "config.h",
    content = '#undef SYSTEM_LIBC\n#define MES_VERSION "{}"\n'.format(VERSION),
)

# --- M2-Planet pipeline ---

# M2-Planet reads its inputs in this order, so syscall.h must come before the
# files that use its SYS_* defines, such as _open3.c.
M2_SOURCES = [
    "include/mes/lib-mini.h",
    "include/mes/lib.h",
    "lib/linux/x86_64-mes-m2/crt1.c",
    "lib/mes/__init_io.c",
    "lib/linux/x86_64-mes-m2/_exit.c",
    "lib/linux/x86_64-mes-m2/_write.c",
    "lib/mes/globals.c",
    "lib/m2/cast.c",
    "lib/stdlib/exit.c",
    "lib/mes/write.c",
    "include/linux/x86_64/syscall.h",
    "lib/linux/x86_64-mes-m2/syscall.c",
    "lib/stub/__raise.c",
    "lib/linux/brk.c",
    "lib/linux/malloc.c",
    "lib/string/memset.c",
    "lib/linux/read.c",
    "lib/mes/fdgetc.c",
    "lib/stdio/getchar.c",
    "lib/stdio/putchar.c",
    "lib/stub/__buffered_read.c",
    "include/errno.h",
    "include/fcntl.h",
    "lib/linux/_open3.c",
    "lib/linux/open.c",
    "lib/mes/mes_open.c",
    "lib/string/strlen.c",
    "lib/mes/eputs.c",
    "lib/mes/fdputc.c",
    "lib/mes/eputc.c",
    "include/time.h",
    "include/sys/time.h",
    "include/m2/types.h",
    "include/sys/types.h",
    "include/sys/utsname.h",
    "include/mes/mes.h",
    "include/mes/builtins.h",
    "include/mes/constants.h",
    "include/mes/symbols.h",
    "lib/mes/__assert_fail.c",
    "lib/mes/assert_msg.c",
    "lib/string/strncmp.c",
    "lib/posix/getenv.c",
    "lib/mes/fdputs.c",
    "lib/mes/ntoab.c",
    "lib/ctype/isdigit.c",
    "lib/ctype/isxdigit.c",
    "lib/ctype/isspace.c",
    "lib/ctype/isnumber.c",
    "lib/mes/abtol.c",
    "lib/stdlib/atoi.c",
    "lib/string/memcpy.c",
    "lib/stdlib/free.c",
    "lib/stdlib/realloc.c",
    "lib/string/strcpy.c",
    "lib/mes/itoa.c",
    "lib/mes/ltoa.c",
    "lib/mes/fdungetc.c",
    "lib/posix/setenv.c",
    "lib/linux/access.c",
    "include/linux/m2/kernel-stat.h",
    "include/sys/stat.h",
    "lib/linux/chmod.c",
    "lib/linux/ioctl3.c",
    "include/sys/ioctl.h",
    "lib/m2/isatty.c",
    "include/signal.h",
    "lib/linux/fork.c",
    "lib/m2/execve.c",
    "lib/m2/execv.c",
    "include/sys/resource.h",
    "lib/linux/wait4.c",
    "lib/linux/waitpid.c",
    "lib/linux/gettimeofday.c",
    "lib/linux/clock_gettime.c",
    "lib/m2/time.c",
    "lib/linux/_getcwd.c",
    "include/limits.h",
    "lib/m2/getcwd.c",
    "lib/linux/dup.c",
    "lib/linux/dup2.c",
    "lib/string/strcmp.c",
    "lib/string/memcmp.c",
    "lib/linux/uname.c",
    "lib/linux/unlink.c",
    "src/builtins.c",
    "src/core.c",
    "src/display.c",
    "src/eval-apply.c",
    "src/gc.c",
    "src/hash.c",
    "src/lib.c",
    "src/m2.c",
    "src/math.c",
    "src/mes.c",
    "src/module.c",
    "src/posix.c",
    "src/reader.c",
    "src/stack.c",
    "src/string.c",
    "src/struct.c",
    "src/symbol.c",
    "src/variable.c",
    "src/vector.c",
]

M2_Planet(
    name = "mes.M1",
    srcs = [":config.h"] + [":mes-{}[{}]".format(VERSION, path) for path in M2_SOURCES],
    arch = "amd64",
    defines = [
        "__x86_64__=1",
        "__linux__=1",
    ],
    tools = TOOLS,
)

blood_elf(
    name = "mes.blood-elf-M1",
    srcs = [":mes.M1"],
    args = [
        "--64",
        "--little-endian",
    ],
    tools = TOOLS,
)

M1(
    name = "mes.hex2",
    srcs = [
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/amd64_defs.M1",
        ":mes-{}[lib/x86_64-mes/x86_64.M1]".format(VERSION),
        ":mes-{}[lib/linux/x86_64-mes-m2/crt1.M1]".format(VERSION),
        ":mes.M1",
        ":mes.blood-elf-M1",
    ],
    args = [
        "--architecture",
        "amd64",
        "--little-endian",
    ],
    tools = TOOLS,
)

hex2(
    name = "mes.bin",
    srcs = [
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/ELF-amd64.hex2",
        ":mes.hex2",
    ],
    args = [
        "--architecture",
        "amd64",
        "--little-endian",
        "--base-address",
        "0x1000000",
    ],
    tools = TOOLS,
)

# --- Source preparation ---

# Compiler configuration is independent of the checkout and Buck output path.
# MES_PREFIX/includedir/libdir are supplied explicitly by compiler commands.
[
    replace(
        name = name,
        src = src,
        after = after,
        before = before,
        tool = TOOLS_EXTRA + ":replace",
    )
    for name, src, before, after in [
        (
            "mescc-prefix.scm",
            ":mes-{}[scripts/mescc.scm.in]".format(VERSION),
            "@prefix@",
            "",
        ),
        ("mescc-version.scm", ":mescc-prefix.scm", "@VERSION@", VERSION),
        ("mescc-cpu.scm", ":mescc-version.scm", "@mes_cpu@", MES_CPU),
        ("mescc.scm", ":mescc-cpu.scm", "@mes_kernel@", "linux"),
    ]
]

# Preserve conditional values and stack depth when MesCC spills registers.
[
    exact_patch(
        name = name,
        src = src,
        output = "compile.scm",
        patch = ":patches/" + patch + ".patch",
    )
    for name, src, patch in [
        (
            "compile-values.scm",
            ":mes-{}[module/mescc/compile.scm]".format(VERSION),
            "conditional-values",
        ),
        ("compile.scm", ":compile-values.scm", "conditional-jump"),
    ]
]

[export_file(name = path) for path in glob(["patches/*.patch"])]

# The tree MesCC reads, with the configured mescc.scm and compile.scm and the
# x86_64 kernel headers as include/arch.
filegroup(
    name = "mes-src",
    srcs = {path: ":mes-{}[{}]".format(VERSION, path) for path in PREPARED_FILES} | {
        "module/mescc/compile.scm": ":compile.scm",
        "include/mes/config.h": ":config.h",
        "bin/mescc.scm": ":mescc.scm",
        "mes/module/srfi/srfi-9.mes": ":mes-{}[mes/module/srfi/srfi-9-struct.mes]".format(VERSION),
        "mes/module/srfi/srfi-9/gnu.mes": ":mes-{}[mes/module/srfi/srfi-9/gnu-struct.mes]".format(VERSION),
    } | {
        "include/arch/" + name: ":mes-{}[include/linux/x86_64/{}]".format(VERSION, name)
        for name in [
            "syscall.h",
            "kernel-stat.h",
            "signal.h",
        ]
    },
)

# --- MesCC to a fixed point ---

# The libraries each stage builds.
LIBRARIES = {
    "libc-mini": LIBC_MINI_SOURCES,
    "libmescc": LIBMESCC_SOURCES,
    "libc": LIBC_SOURCES,
    "libc+tcc": LIBC_TCC_SOURCES,
}

# Each stage runs one Mes interpreter on MesCC to build a startup object, the
# libraries and the next interpreter from the same sources. mes.bin comes
# from M2-Planet; s2-mes and s3-mes must be identical.
STAGES = [
    # (interpreter, startup object, library prefix, library directory, output)
    (":mes.bin", "mescc-crt1", "", "mes-m2-libs", "mes-full"),
    (":mes-full", "s2-crt1", "s2-", "s2-libs", "s2-mes"),
    (":s2-mes", "s3-crt1", "s3-", "s3-libs", "s3-mes"),
]

[
    [
        mescc_compile(
            name = crt1,
            mes_cpu = MES_CPU,
            mes_m2 = mes,
            nyacc = NYACC,
            source_path = "lib/linux/x86_64-mes-mescc/crt1.c",
            src_prefix = ":mes-src",
            tools = TOOLS,
        ),
        [
            mescc_build_lib(
                name = prefix + library + ".a",
                mes_cpu = MES_CPU,
                mes_m2 = mes,
                nyacc = NYACC,
                sources = sources,
                src_prefix = ":mes-src",
                tools = TOOLS,
            )
            for library, sources in LIBRARIES.items()
        ],
        filegroup(
            name = libs,
            srcs = {
                MES_CPU + "-mes/crt1.o": ":" + crt1 + "[crt1.o]",
                MES_CPU + "-mes/crt1.s": ":" + crt1 + "[crt1.s]",
            } | {
                MES_CPU + "-mes/" + library + suffix: ":" + prefix + library + ".a" + subtarget
                for library in LIBRARIES
                for suffix, subtarget in [
                    (".a", ""),
                    (".s", "[s]"),
                ]
            },
        ),
        mescc_build_mes(
            name = output,
            crt1 = ":" + crt1 + "[crt1.o]",
            lib_dir = ":" + libs,
            mes_cpu = MES_CPU,
            mes_m2 = mes,
            nyacc = NYACC,
            sources = MES_SOURCES,
            src_prefix = ":mes-src",
            tools = TOOLS,
        ),
    ]
    for mes, crt1, prefix, libs, output in STAGES
]

compare_test(
    name = "mes-fixed-point",
    actual = ":s2-mes",
    expected = ":s3-mes",
)

# --- Runnable interpreter and compiler ---

MES_ENV = {
    "MES_PREFIX": "$(location :mes-src)",
    "GUILE_LOAD_PATH": "$(location :mes-src)/mes/module:$(location :mes-src)/module:$(location {})/module".format(NYACC),
    "MES_ARENA": "100000000",
    "MES_MAX_ARENA": "100000000",
    "MES_STACK": "6000000",
}

# The final interpreter with the environment Mes needs.
configured_tool(
    name = "mes",
    env = MES_ENV,
    env_tool = "cellar//bootstrap/stage0-posix/cellar-extra:envexec",
    tool = ":s3-mes",
)

# MesCC as `mescc ARGS`, with the final libraries and stage0 tools.
configured_tool(
    name = "mescc",
    args = [
        "-e",
        "main",
        "$(location :mes-src)/bin/mescc.scm",
        "--",
    ],
    env = {
        "MES_PREFIX": MES_ENV["MES_PREFIX"],
        "GUILE_LOAD_PATH": MES_ENV["GUILE_LOAD_PATH"],
        "srcdest": "$(location :mes-src)/",
        "includedir": "$(location :mes-src)/include",
        "libdir": "$(location :s3-libs)",
        "MES_ARENA": "100000000",
        "MES_MAX_ARENA": "100000000",
        "MES_STACK": "6000000",
        "M1": "$(location {})/M1".format(TOOLS),
        "HEX2": "$(location {})/hex2".format(TOOLS),
        "BLOOD_ELF": "$(location {})/blood-elf".format(TOOLS),
        "MES_UNINSTALLED": "1",
    },
    env_tool = "cellar//bootstrap/stage0-posix/cellar-extra:envexec",
    tool = ":s3-mes",
)

# --- Tests ---

export_file(name = "hello.c")

mescc_test(
    name = "hello-test",
    src = ":hello.c",
    crt1 = ":mescc-crt1[crt1.o]",
    lib_dir = ":mes-m2-libs",
    mes_cpu = MES_CPU,
    mes_m2 = ":mes.bin",
    nyacc = NYACC,
    src_prefix = ":mes-src",
    tools = TOOLS,
)
