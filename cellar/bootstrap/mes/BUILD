# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:defs.bzl", "bootstrap", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "replace", "ungz", "untar", "write_file")
load(":defs.bzl", "M1", "M2_Planet", "blood_elf", "hex2", "mes_binary", "mes_libs", "mescc_binary", "mescc_build_lib", "mescc_build_mes", "mescc_compile", "mescc_fixed_point_test", "mescc_test")
load(":manifest.bzl", "PREPARED_FILES")
load(":sources.bzl", "MES_SOURCES", "libc_mini_sources", "libc_sources", "libc_tcc_sources", "libmescc_sources")

_VERSION = "0.27"

_TOOLS_EXTRA = "cellar//bootstrap/stage0-posix/mescc-tools-extra"

_CELLAR_EXTRA = "cellar//bootstrap/stage0-posix/cellar-extra"

_LINUX_COMPAT = ["cellar//bootstrap/platforms:linux"]

VERSION = _VERSION

# On aarch64, we cross-compile mes to 32-bit ARM (armv7l). Upstream GNU
# Mes 0.27 has full ARM support but no aarch64 support. The aarch64 Linux
# kernel runs 32-bit ARM binaries natively via its compat layer. The
# aarch64 stage0 tools (M2-Planet, M1, hex2) support cross-compilation
# to armv7l via --architecture armv7l.
#
# stage0_cpu: architecture flag for M2-Planet/M1/hex2 (--architecture)
# mes_cpu: mes source tree directory prefix (arm-mes-m2, x86_64-mes-m2)
# cc_cpu: C preprocessor define (__arm__, __x86_64__)

CPU_0 = bootstrap.select({
    "cellar//bootstrap/platforms:amd64": "amd64",
    "cellar//bootstrap/platforms:aarch64": "armv7l",
})

MES_CPU = bootstrap.select({
    "cellar//bootstrap/platforms:amd64": "x86_64",
    "cellar//bootstrap/platforms:aarch64": "arm",
})

TOOLS = bootstrap.select({
    "cellar//bootstrap/platforms:amd64": "cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
    "cellar//bootstrap/platforms:aarch64": "cellar//bootstrap/stage0-posix/seeds/linux-arm64:bins",
})

# --- Download and extract ---

download_file(
    name = "mes-{}.tar.gz".format(VERSION),
    hash = "033ee656d98cfc04a826eab27eed6e6a276d15bbb980a7cd71d00f30227aaaa8",
    target_compatible_with = _LINUX_COMPAT,
    urls = ["https://mirrors.kernel.org/gnu/mes/mes-{}.tar.gz".format(VERSION)],
)

ungz(
    name = "mes-{}.tar".format(VERSION),
    input = ":mes-{}.tar.gz".format(VERSION),
    target_compatible_with = _LINUX_COMPAT,
    ungz = _TOOLS_EXTRA + ":ungz",
)

_M2_FILES_AMD64 = [
    "include/mes/lib-mini.h",
    "include/mes/lib.h",
    "include/linux/x86_64/syscall.h",
    "include/errno.h",
    "include/fcntl.h",
    "include/time.h",
    "include/sys/time.h",
    "include/m2/types.h",
    "include/sys/types.h",
    "include/sys/utsname.h",
    "include/mes/mes.h",
    "include/mes/builtins.h",
    "include/mes/constants.h",
    "include/mes/symbols.h",
    "include/linux/m2/kernel-stat.h",
    "include/sys/stat.h",
    "include/sys/ioctl.h",
    "include/signal.h",
    "include/sys/resource.h",
    "include/limits.h",
    "lib/linux/x86_64-mes-m2/crt1.c",
    "lib/mes/__init_io.c",
    "lib/linux/x86_64-mes-m2/_exit.c",
    "lib/linux/x86_64-mes-m2/_write.c",
    "lib/mes/globals.c",
    "lib/m2/cast.c",
    "lib/stdlib/exit.c",
    "lib/mes/write.c",
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
    "lib/linux/_open3.c",
    "lib/linux/open.c",
    "lib/mes/mes_open.c",
    "lib/string/strlen.c",
    "lib/mes/eputs.c",
    "lib/mes/fdputc.c",
    "lib/mes/eputc.c",
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
    "lib/linux/chmod.c",
    "lib/linux/ioctl3.c",
    "lib/m2/isatty.c",
    "lib/linux/fork.c",
    "lib/m2/execve.c",
    "lib/m2/execv.c",
    "lib/linux/wait4.c",
    "lib/linux/waitpid.c",
    "lib/linux/gettimeofday.c",
    "lib/linux/clock_gettime.c",
    "lib/m2/time.c",
    "lib/linux/_getcwd.c",
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
    "lib/m2/x86_64/x86_64_defs.M1",
    "lib/x86_64-mes/x86_64.M1",
    "lib/linux/x86_64-mes-m2/crt1.M1",
]

# --- M2-Planet source lists ---
# These must be defined before untar() since they determine which files
# to extract. The file order matters for M2-Planet: syscall.h must come
# before files that use SYS_* defines (like _open3.c).

_M2_SRCS_AMD64 = [
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

# ARM M2-Planet sources: same as kaem.run order with arm-mes-m2 paths
_M2_SRCS_ARM = [
    "include/mes/lib-mini.h",
    "include/mes/lib.h",
    "lib/linux/arm-mes-m2/crt1.c",
    "lib/mes/__init_io.c",
    "lib/linux/arm-mes-m2/_exit.c",
    "lib/linux/arm-mes-m2/_write.c",
    "lib/mes/globals.c",
    "lib/m2/cast.c",
    "lib/stdlib/exit.c",
    "lib/mes/write.c",
    "include/linux/arm/syscall.h",
    "lib/linux/arm-mes-m2/syscall.c",
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

_M2_FILES_ARM = _M2_SRCS_ARM + [
    "lib/m2/arm/arm_defs.M1",
    "lib/arm-mes/arm.M1",
    "lib/linux/arm-mes-m2/crt1.M1",
]

# --- Extract and prepare ---

untar(
    name = "mes-{}".format(VERSION),
    chdirenv = _CELLAR_EXTRA + ":chdirenv",
    files = bootstrap.select({
        "cellar//bootstrap/platforms:amd64": _M2_FILES_AMD64 + PREPARED_FILES + ["scripts/mescc.scm.in"],
        "cellar//bootstrap/platforms:aarch64": _M2_FILES_ARM + PREPARED_FILES + ["scripts/mescc.scm.in"],
    }),
    input = ":mes-{}.tar".format(VERSION),
    target_compatible_with = _LINUX_COMPAT,
    untar = _TOOLS_EXTRA + ":untar",
)

write_file(
    name = "config.h",
    content = '#undef SYSTEM_LIBC\n#define MES_VERSION "{}"\n'.format(VERSION),
    target_compatible_with = _LINUX_COMPAT,
)

# --- M2-Planet pipeline ---

M2_Planet(
    name = "mes.M1",
    srcs = [":config.h"] + bootstrap.select({
        "cellar//bootstrap/platforms:amd64": [
            ":mes-{}[{}]".format(VERSION, f)
            for f in _M2_SRCS_AMD64
        ],
        # ARM sources follow the same order as kaem.run: arch-specific
        # crt1/_exit/_write before shared libc, syscall.h before _open3.c
        "cellar//bootstrap/platforms:aarch64": [
            ":mes-{}[{}]".format(VERSION, f)
            for f in _M2_SRCS_ARM
        ],
    }),
    arch_mes = MES_CPU,
    arch_stage0 = CPU_0,
    defines = bootstrap.select({
        "cellar//bootstrap/platforms:amd64": [
            "__x86_64__=1",
            "__linux__=1",
        ],
        "cellar//bootstrap/platforms:aarch64": [
            "__arm__=1",
            "__linux__=1",
        ],
    }),
    target_compatible_with = _LINUX_COMPAT,
    tools = TOOLS,
)

blood_elf(
    name = "mes.blood-elf-M1",
    srcs = [":mes.M1"],
    args = bootstrap.select({
        "cellar//bootstrap/platforms:amd64": [
            "--64",
            "--little-endian",
        ],
        "cellar//bootstrap/platforms:aarch64": ["--little-endian"],
    }),
    target_compatible_with = _LINUX_COMPAT,
    tools = TOOLS,
)

M1(
    name = "mes.hex2",
    srcs = bootstrap.select({
        "cellar//bootstrap/platforms:amd64": [
            "cellar//bootstrap/stage0-posix/m2-libc:amd64/amd64_defs.M1",
            ":mes-{}[lib/x86_64-mes/x86_64.M1]".format(VERSION),
            ":mes-{}[lib/linux/x86_64-mes-m2/crt1.M1]".format(VERSION),
        ],
        "cellar//bootstrap/platforms:aarch64": [
            "cellar//bootstrap/stage0-posix/m2-libc:armv7l/armv7l_defs.M1",
            ":mes-{}[lib/arm-mes/arm.M1]".format(VERSION),
            ":mes-{}[lib/linux/arm-mes-m2/crt1.M1]".format(VERSION),
        ],
    }) + [
        ":mes.M1",
        ":mes.blood-elf-M1",
    ],
    args = bootstrap.select({
        "cellar//bootstrap/platforms:amd64": [
            "--architecture",
            "amd64",
            "--little-endian",
        ],
        "cellar//bootstrap/platforms:aarch64": [
            "--architecture",
            "armv7l",
            "--little-endian",
        ],
    }),
    target_compatible_with = _LINUX_COMPAT,
    tools = TOOLS,
)

hex2(
    name = "mes.bin",
    srcs = bootstrap.select({
        "cellar//bootstrap/platforms:amd64": ["cellar//bootstrap/stage0-posix/m2-libc:amd64/ELF-amd64.hex2"],
        "cellar//bootstrap/platforms:aarch64": ["cellar//bootstrap/stage0-posix/m2-libc:armv7l/ELF-armv7l.hex2"],
    }) + [":mes.hex2"],
    args = bootstrap.select({
        "cellar//bootstrap/platforms:amd64": [
            "--architecture",
            "amd64",
            "--little-endian",
            "--base-address",
            "0x1000000",
        ],
        "cellar//bootstrap/platforms:aarch64": [
            "--architecture",
            "armv7l",
            "--little-endian",
            "--base-address",
            "0x1000000",
        ],
    }),
    target_compatible_with = _LINUX_COMPAT,
    tools = TOOLS,
)

# --- Source preparation ---

# Compiler configuration is independent of the checkout and Buck output path.
# MES_PREFIX/includedir/libdir are supplied explicitly by compiler commands.
replace(
    name = "mescc-prefix.scm",
    src = ":mes-0.27[scripts/mescc.scm.in]",
    after = "",
    before = "@prefix@",
    tool = _TOOLS_EXTRA + ":replace",
)

replace(
    name = "mescc-version.scm",
    src = ":mescc-prefix.scm",
    after = VERSION,
    before = "@VERSION@",
    tool = _TOOLS_EXTRA + ":replace",
)

replace(
    name = "mescc-cpu.scm",
    src = ":mescc-version.scm",
    after = MES_CPU,
    before = "@mes_cpu@",
    tool = _TOOLS_EXTRA + ":replace",
)

replace(
    name = "mescc.scm",
    src = ":mescc-cpu.scm",
    after = "linux",
    before = "@mes_kernel@",
    tool = _TOOLS_EXTRA + ":replace",
)

filegroup(
    name = "mes-src",
    srcs = bootstrap.select({
        "cellar//bootstrap/platforms:amd64": {path: ":mes-0.27[{}]".format(path) for path in PREPARED_FILES} | {
            "include/mes/config.h": ":config.h",
            "bin/mescc.scm": ":mescc.scm",
            "mes/module/srfi/srfi-9.mes": ":mes-0.27[mes/module/srfi/srfi-9-struct.mes]",
            "mes/module/srfi/srfi-9/gnu.mes": ":mes-0.27[mes/module/srfi/srfi-9/gnu-struct.mes]",
        } | {
            "include/arch/" + name: ":mes-0.27[include/linux/x86_64/{}]".format(name)
            for name in [
                "syscall.h",
                "kernel-stat.h",
                "signal.h",
            ]
        },
        "cellar//bootstrap/platforms:aarch64": {path: ":mes-0.27[{}]".format(path) for path in PREPARED_FILES} | {
            "include/mes/config.h": ":config.h",
            "bin/mescc.scm": ":mescc.scm",
            "mes/module/srfi/srfi-9.mes": ":mes-0.27[mes/module/srfi/srfi-9-struct.mes]",
            "mes/module/srfi/srfi-9/gnu.mes": ":mes-0.27[mes/module/srfi/srfi-9/gnu-struct.mes]",
        } | {
            "include/arch/" + name: ":mes-0.27[include/linux/arm/{}]".format(name)
            for name in [
                "syscall.h",
                "kernel-stat.h",
                "signal.h",
            ]
        },
    }),
    target_compatible_with = _LINUX_COMPAT,
)

# --- mescc libraries ---

NYACC = "cellar//bootstrap/nyacc:modules"

mescc_compile(
    name = "mescc-crt1",
    chdirenv = _CELLAR_EXTRA + ":chdirenv",
    mes_cpu = MES_CPU,
    mes_m2 = ":mes.bin",
    nyacc = NYACC,
    source_path = bootstrap.select({
        "cellar//bootstrap/platforms:amd64": "lib/linux/x86_64-mes-mescc/crt1.c",
        "cellar//bootstrap/platforms:aarch64": "lib/linux/arm-mes-mescc/crt1.c",
    }),
    src_prefix = ":mes-src",
    target_compatible_with = _LINUX_COMPAT,
    tools = TOOLS,
)

mescc_build_lib(
    name = "libc-mini.a",
    catm = _TOOLS_EXTRA + ":catm",
    chdirenv = _CELLAR_EXTRA + ":chdirenv",
    mes_cpu = MES_CPU,
    mes_m2 = ":mes.bin",
    nyacc = NYACC,
    sources = bootstrap.select({
        "cellar//bootstrap/platforms:amd64": libc_mini_sources("x86_64"),
        "cellar//bootstrap/platforms:aarch64": libc_mini_sources("arm"),
    }),
    src_prefix = ":mes-src",
    target_compatible_with = _LINUX_COMPAT,
    tools = TOOLS,
)

mescc_build_lib(
    name = "libmescc.a",
    catm = _TOOLS_EXTRA + ":catm",
    chdirenv = _CELLAR_EXTRA + ":chdirenv",
    mes_cpu = MES_CPU,
    mes_m2 = ":mes.bin",
    nyacc = NYACC,
    sources = bootstrap.select({
        "cellar//bootstrap/platforms:amd64": libmescc_sources("x86_64"),
        "cellar//bootstrap/platforms:aarch64": libmescc_sources("arm"),
    }),
    src_prefix = ":mes-src",
    target_compatible_with = _LINUX_COMPAT,
    tools = TOOLS,
)

mescc_build_lib(
    name = "libc.a",
    catm = _TOOLS_EXTRA + ":catm",
    chdirenv = _CELLAR_EXTRA + ":chdirenv",
    mes_cpu = MES_CPU,
    mes_m2 = ":mes.bin",
    nyacc = NYACC,
    sources = bootstrap.select({
        "cellar//bootstrap/platforms:amd64": libc_sources("x86_64"),
        "cellar//bootstrap/platforms:aarch64": libc_sources("arm"),
    }),
    src_prefix = ":mes-src",
    target_compatible_with = _LINUX_COMPAT,
    tools = TOOLS,
)

mescc_build_lib(
    name = "libc+tcc.a",
    catm = _TOOLS_EXTRA + ":catm",
    chdirenv = _CELLAR_EXTRA + ":chdirenv",
    mes_cpu = MES_CPU,
    mes_m2 = ":mes.bin",
    nyacc = NYACC,
    sources = bootstrap.select({
        "cellar//bootstrap/platforms:amd64": libc_tcc_sources("x86_64"),
        "cellar//bootstrap/platforms:aarch64": libc_tcc_sources("arm"),
    }),
    src_prefix = ":mes-src",
    target_compatible_with = _LINUX_COMPAT,
    tools = TOOLS,
)

mes_libs(
    name = "mes-m2-libs",
    libs = {
        "crt1.o": ":mescc-crt1[crt1.o]",
        "crt1.s": ":mescc-crt1[crt1.s]",
        "libc-mini.a": ":libc-mini.a",
        "libc-mini.s": ":libc-mini.a[s]",
        "libmescc.a": ":libmescc.a",
        "libmescc.s": ":libmescc.a[s]",
        "libc.a": ":libc.a",
        "libc.s": ":libc.a[s]",
        "libc+tcc.a": ":libc+tcc.a",
        "libc+tcc.s": ":libc+tcc.a[s]",
    },
    mes_cpu = MES_CPU,
    target_compatible_with = _LINUX_COMPAT,
)

# --- Full mes binary ---

mescc_build_mes(
    name = "mes-full",
    chdirenv = _CELLAR_EXTRA + ":chdirenv",
    crt1 = ":mescc-crt1[crt1.o]",
    lib_dir = ":mes-m2-libs",
    mes_cpu = MES_CPU,
    mes_m2 = ":mes.bin",
    nyacc = NYACC,
    sources = MES_SOURCES,
    src_prefix = ":mes-src",
    target_compatible_with = _LINUX_COMPAT,
    tools = TOOLS,
)

# --- Mescc self-hosting fixed point ---

[
    mescc_build_lib(
        name = "{}-{}".format(stage, lib_name),
        catm = _TOOLS_EXTRA + ":catm",
        chdirenv = _CELLAR_EXTRA + ":chdirenv",
        mes_cpu = MES_CPU,
        mes_m2 = mes_m2,
        nyacc = NYACC,
        sources = bootstrap.select({
            "cellar//bootstrap/platforms:amd64": sources_fn("x86_64"),
            "cellar//bootstrap/platforms:aarch64": sources_fn("arm"),
        }),
        src_prefix = ":mes-src",
        target_compatible_with = _LINUX_COMPAT,
        tools = TOOLS,
    )
    for stage, mes_m2 in [
        ("s2", ":mes-full"),
        ("s3", ":s2-mes"),
    ]
    for lib_name, sources_fn in [
        ("libc-mini.a", libc_mini_sources),
        ("libmescc.a", libmescc_sources),
        ("libc.a", libc_sources),
        ("libc+tcc.a", libc_tcc_sources),
    ]
]

[
    mescc_compile(
        name = "{}-crt1".format(stage),
        chdirenv = _CELLAR_EXTRA + ":chdirenv",
        mes_cpu = MES_CPU,
        mes_m2 = mes_m2,
        nyacc = NYACC,
        source_path = bootstrap.select({
            "cellar//bootstrap/platforms:amd64": "lib/linux/x86_64-mes-mescc/crt1.c",
            "cellar//bootstrap/platforms:aarch64": "lib/linux/arm-mes-mescc/crt1.c",
        }),
        src_prefix = ":mes-src",
        target_compatible_with = _LINUX_COMPAT,
        tools = TOOLS,
    )
    for stage, mes_m2 in [
        ("s2", ":mes-full"),
        ("s3", ":s2-mes"),
    ]
]

[
    mes_libs(
        name = "{}-libs".format(stage),
        libs = {
            "crt1.o": ":{}-crt1[crt1.o]".format(stage),
            "crt1.s": ":{}-crt1[crt1.s]".format(stage),
            "libc-mini.a": ":{}-libc-mini.a".format(stage),
            "libc-mini.s": ":{}-libc-mini.a[s]".format(stage),
            "libmescc.a": ":{}-libmescc.a".format(stage),
            "libmescc.s": ":{}-libmescc.a[s]".format(stage),
            "libc.a": ":{}-libc.a".format(stage),
            "libc.s": ":{}-libc.a[s]".format(stage),
            "libc+tcc.a": ":{}-libc+tcc.a".format(stage),
            "libc+tcc.s": ":{}-libc+tcc.a[s]".format(stage),
        },
        mes_cpu = MES_CPU,
        target_compatible_with = _LINUX_COMPAT,
    )
    for stage in [
        "s2",
        "s3",
    ]
]

[
    mescc_build_mes(
        name = "{}-mes".format(stage),
        chdirenv = _CELLAR_EXTRA + ":chdirenv",
        crt1 = ":{}-crt1[crt1.o]".format(stage),
        lib_dir = ":{}-libs".format(stage),
        mes_cpu = MES_CPU,
        mes_m2 = mes_m2,
        nyacc = NYACC,
        sources = MES_SOURCES,
        src_prefix = ":mes-src",
        target_compatible_with = _LINUX_COMPAT,
        tools = TOOLS,
    )
    for stage, mes_m2 in [
        ("s2", ":mes-full"),
        ("s3", ":s2-mes"),
    ]
]

mescc_fixed_point_test(
    name = "mes-fixed-point",
    bytecmp = _CELLAR_EXTRA + ":bytecmp",
    stage2 = ":s2-mes",
    stage3 = ":s3-mes",
    target_compatible_with = _LINUX_COMPAT,
)

# --- Wrapper targets ---

mes_binary(
    name = "mes",
    bin = "cellar//bootstrap/mes:s3-mes",
    envexec = _CELLAR_EXTRA + ":envexec",
    nyacc = NYACC,
    src_prefix = "cellar//bootstrap/mes:mes-src",
    target_compatible_with = _LINUX_COMPAT,
)

mescc_binary(
    name = "mescc",
    envexec = _CELLAR_EXTRA + ":envexec",
    lib_dir = "cellar//bootstrap/mes:s3-libs",
    mes_m2 = "cellar//bootstrap/mes:s3-mes",
    nyacc = NYACC,
    src_prefix = "cellar//bootstrap/mes:mes-src",
    target_compatible_with = _LINUX_COMPAT,
    tools = TOOLS,
)

# --- Tests ---

export_file(
    name = "hello.c",
    target_compatible_with = _LINUX_COMPAT,
)

mescc_test(
    name = "hello-test",
    src = ":hello.c",
    chdirenv = _CELLAR_EXTRA + ":chdirenv",
    crt1 = ":mescc-crt1[crt1.o]",
    lib_dir = ":mes-m2-libs",
    mes_cpu = MES_CPU,
    mes_m2 = ":mes.bin",
    nyacc = NYACC,
    src_prefix = ":mes-src",
    target_compatible_with = _LINUX_COMPAT,
    tools = TOOLS,
)
