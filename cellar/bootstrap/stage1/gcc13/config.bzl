# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap/stage1/gcc:defs.bzl", "TARGET")

# The configuration gcc_port writes for GCC 13.5, as configure would find it
# for a native host built by GCC 10.5 and libstdc++ 10 on musl 1.2.5, with
# GNU binutils 2.41 (x86_64 only, zlib, no zstd) and a static musl 1.2.5
# target.

# library-config.h values beside the shared LIBRARY_CONFIG_ON list.
LIBRARY_CONFIG_VALUES = {
    "SIZEOF_INT": "4",
    "SIZEOF_LONG": "8",
    "SIZEOF_LONG_LONG": "8",
    "SIZEOF_SIZE_T": "8",
    "SIZEOF_VOID_P": "8",
    "SIZEOF_DEV_T": "8",
    "SIZEOF_INO_T": "8",
    "STACK_DIRECTION": "-1",
    "UNSIGNED_64BIT_TYPE": "unsigned long",
    "ICONV_CONST": "",
    "PACKAGE": "\"gcc\"",
    "PACKAGE_VERSION": "\"13.5.0\"",
    "SIZEOF_CHAR": "1",
    "SIZEOF_SHORT": "2",
    "HAVE_DECL_FPRINTF_UNLOCKED": "0",
    # musl 1.2.5 declares basename only in <libgen.h>, so libiberty.h
    # declares it. HAVE_BASENAME leaves libiberty's GNU basename unbuilt, so
    # callers get musl's POSIX function, as in an upstream musl build.
    "HAVE_DECL_BASENAME": "0",
    # Release checking keeps assertions and drops extra checks.
    "CHECKING_P": "0",
}

# auto-host.h, from gcc/config.in. Macros already set by library-config.h
# are omitted.
GCC_CONFIG_ON = [
    "ENABLE_RUNTIME_CHECKING",
    "ENABLE_DECIMAL_FLOAT",
    "ENABLE_DECIMAL_BID_FORMAT",
    "ENABLE_LIBQUADMATH_SUPPORT",
    # Host types and headers.
    "HAVE_CLOCK_T",
    "HAVE_STRUCT_TMS",
    "HAVE_INTMAX_T",
    "HAVE_UINTMAX_T",
    "HAVE_LONG_LONG_INT",
    "HAVE_UNSIGNED_LONG_LONG_INT",
    "INT64_T_IS_LONG",
    "HAVE_SWAP_IN_UTILITY",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_TIMES_H",
    "HAVE_LANGINFO_H",
    "HAVE_WCHAR_H",
    "HAVE_FTW_H",
    # Only config/mips/driver-native.cc reads it.
    "HAVE_SYS_AUXV_H",
    "HAVE_DLFCN_H",
    "GWINSZ_IN_SYS_IOCTL",
    "HAVE_LC_MESSAGES",
    "HOST_HAS_F_SETLKW",
    # fcntl, personality and socket compile probes.
    "HOST_HAS_O_CLOEXEC",
    "HOST_HAS_O_NONBLOCK",
    "HOST_HAS_PERSONALITY_ADDR_NO_RANDOMIZE",
    "HAVE_AF_UNIX",
    "HAVE_AF_INET6",
    # Host functions musl provides.
    "HAVE_KILL",
    "HAVE_POPEN",
    "HAVE_NL_LANGINFO",
    "HAVE_MBSTOWCS",
    "HAVE_WORKING_MBSTOWCS",
    "HAVE_WCSWIDTH",
    "HAVE_SETLOCALE",
    "HAVE_MADVISE",
    "HAVE_POSIX_FALLOCATE",
    "HAVE_FSTATAT",
    "HAVE_GETAUXVAL",
    "HAVE_MMAP_FILE",
    "HAVE_MMAP_ANON",
    "HAVE_MMAP_DEV_ZERO",
    # Target C library facts.
    "TARGET_LIBC_PROVIDES_SSP",
    "TARGET_DL_ITERATE_PHDR",
    # GNU as 2.41, x86_64 ELF.
    "HAVE_GAS_BALIGN_AND_P2ALIGN",
    "HAVE_GAS_MAX_SKIP_P2ALIGN",
    "HAVE_GAS_SUBSECTION_ORDERING",
    "HAVE_GAS_WEAK",
    "HAVE_GAS_WEAKREF",
    "HAVE_GAS_HIDDEN",
    "HAVE_GAS_LOC_STMT",
    "HAVE_GAS_DISCRIMINATOR",
    "HAVE_GAS_LCOMM_WITH_ALIGNMENT",
    "HAVE_AS_TLS",
    "HAVE_AS_DWARF2_DEBUG_LINE",
    "HAVE_AS_DWARF2_DEBUG_VIEW",
    "HAVE_AS_GDWARF2_DEBUG_FLAG",
    # gas 2.41 accepts --gdwarf-5 and discards its own line information once
    # the compiler emits .file 1. The driver then passes --gdwarf-N for every
    # -g compile and leaves .debug_line to gas.
    "HAVE_AS_GDWARF_5_DEBUG_FLAG",
    "HAVE_AS_WORKING_DWARF_N_FLAG",
    "HAVE_AS_DEBUG_PREFIX_MAP",
    "HAVE_AS_LINE_ZERO",
    "HAVE_AS_IX86_FILDS",
    "HAVE_AS_IX86_FILDQ",
    "HAVE_AS_IX86_FFREEP",
    "HAVE_AS_IX86_QUAD",
    "HAVE_AS_IX86_SAHF",
    "HAVE_AS_IX86_HLE",
    "HAVE_AS_IX86_SWAP",
    "HAVE_AS_IX86_DIFF_SECT_DELTA",
    "HAVE_AS_IX86_REP_LOCK_PREFIX",
    "HAVE_AS_IX86_UD2",
    # GNU ld 2.41.
    "HAVE_LD_EH_FRAME_HDR",
    "HAVE_LD_RO_RW_SECTION_MIXING",
    "HAVE_LD_STATIC_DYNAMIC",
    "HAVE_LD_DEMANGLE",
    "HAVE_LD_PIE",
    "HAVE_LD_EH_GC_SECTIONS",
    "HAVE_LD_AS_NEEDED",
    "HAVE_LD_BUILDID",
    # ld 2.40 removed -z bndplt, so HAVE_LD_BNDPLT_SUPPORT is undefined.
    "HAVE_LD_PUSHPOPSTATE_SUPPORT",
]

GCC_CONFIG_VALUES = {
    "ENABLE_EXTRA_CHECKING": "0",
    "GATHER_STATISTICS": "0",
    "ENABLE_FIXED_POINT": "0",
    "ENABLE_VTABLE_VERIFY": "0",
    "ENABLE_ANALYZER": "1",
    "ENABLE_OFFLOADING": "0",
    # -stdlib= is not offered.
    "ENABLE_STDLIB_OPTION": "0",
    "DEFAULT_STK_CLASH_GUARD_SIZE": "0",
    "HAVE_GNU_AS": "1",
    "HAVE_GNU_LD": "1",
    # config.gcc leaves default_gnu_indirect_function unset for musl.
    "HAVE_GNU_INDIRECT_FUNCTION": "0",
    "HAVE_INITFINI_ARRAY_SUPPORT": "1",
    "TARGET_GLIBC_MAJOR": "0",
    "TARGET_GLIBC_MINOR": "0",
    "HAVE_LTO_PLUGIN": "0",
    "DEFAULT_USE_CXA_ATEXIT": "2",
    "EXTRA_MODES_FILE": "\"config/i386/i386-modes.def\"",
    "DIAGNOSTICS_COLOR_DEFAULT": "DIAGNOSTICS_COLOR_AUTO",
    "DIAGNOSTICS_URLS_DEFAULT": "DIAGNOSTICS_URL_AUTO",
    "DOCUMENTATION_ROOT_URL": "\"https://gcc.gnu.org/onlinedocs/\"",
    "CHANGES_ROOT_URL": "\"https://gcc.gnu.org/\"",
    "OFFLOAD_TARGETS": "\"\"",
    "LTOPLUGINSONAME": "\"liblto_plugin.so\"",
    "PLUGIN_LD_SUFFIX": "\"ld\"",
    # Assembler 0/1 probes.
    "HAVE_AS_LEB128": "1",
    "HAVE_GAS_CFI_DIRECTIVE": "1",
    "HAVE_GAS_CFI_PERSONALITY_DIRECTIVE": "1",
    "HAVE_GAS_CFI_SECTIONS_DIRECTIVE": "1",
    "HAVE_GAS_SECTION_EXCLUDE": "1",
    # gas 2.41 accepts the "R" (SHF_GNU_RETAIN) and "o" (SHF_LINK_ORDER)
    # section flags. targhooks.cc tests the latter with a plain if.
    "HAVE_GAS_SHF_GNU_RETAIN": "1",
    "HAVE_GAS_SECTION_LINK_ORDER": "1",
    "HAVE_GAS_SHF_MERGE": "1",
    "HAVE_COMDAT_GROUP": "1",
    "HAVE_AS_IX86_INTERUNIT_MOVQ": "1",
    # 32-bit-only probes fail on the x86_64-only binutils 2.41. Without
    # HAVE_AS_IX86_TLS_GET_ADDR_GOT, -fno-plt TLS calls stay
    # "call __tls_get_addr".
    "HAVE_AS_GOTOFF_IN_DATA": "0",
    "HAVE_AS_IX86_TLSLDMPLT": "0",
    "HAVE_AS_IX86_TLSLDM": "0",
    "HAVE_AS_IX86_GOT32X": "0",
    "HAVE_AS_IX86_TLS_GET_ADDR_GOT": "0",
    # Level 1 is zlib; level 2 would add zstd, which the cellar gas and ld do
    # not support. ld 2.41's --help lists zstd regardless, so a literal
    # configure would report 2 for the linker.
    "HAVE_AS_COMPRESS_DEBUG": "1",
    "AS_COMPRESS_DEBUG_OPTION": "\"--compress-debug-sections\"",
    "AS_NO_COMPRESS_DEBUG_OPTION": "\"--nocompress-debug-sections\"",
    # Linker probes.
    "HAVE_LD_ALIGNED_SHF_MERGE": "1",
    "HAVE_LD_EH_FRAME_CIEV3": "1",
    "HAVE_LD_PIE_COPYRELOC": "1",
    "HAVE_LD_COMPRESS_DEBUG": "1",
    "LD_COMPRESS_DEBUG_OPTION": "\"--compress-debug-sections\"",
    "LD_STATIC_OPTION": "\"-Bstatic\"",
    "LD_DYNAMIC_OPTION": "\"-Bdynamic\"",
    "LD_AS_NEEDED_OPTION": "\"--push-state --as-needed\"",
    "LD_NO_AS_NEEDED_OPTION": "\"--pop-state\"",
    # Host C library declarations not covered by library-config.h.
    "HAVE_DECL_ATOF": "1",
    "HAVE_DECL_ATOL": "1",
    "HAVE_DECL_ATOLL": "1",
    "HAVE_DECL_CLOCK": "1",
    "HAVE_DECL_FREE": "1",
    "HAVE_DECL_GETCWD": "1",
    "HAVE_DECL_GETPAGESIZE": "1",
    "HAVE_DECL_GETRLIMIT": "1",
    "HAVE_DECL_SETRLIMIT": "1",
    "HAVE_DECL_GETRUSAGE": "1",
    "HAVE_DECL_MADVISE": "1",
    "HAVE_DECL_SETENV": "1",
    "HAVE_DECL_UNSETENV": "1",
    "HAVE_DECL_SIGALTSTACK": "1",
    "HAVE_DECL_STPCPY": "1",
    "HAVE_DECL_STRSIGNAL": "1",
    "HAVE_DECL_STRSTR": "1",
    "HAVE_DECL_TIMES": "1",
    "HAVE_DECL_GETWD": "0",
    "HAVE_DECL_MALLINFO": "0",
    "HAVE_DECL_MALLINFO2": "0",
    "HAVE_DECL_LDGETNAME": "0",
}

# HAVE_SIGHANDLER_T stays undefined as upstream, because configure.ac probes
# the misspelled "sighander_t". Other new config.in entries describe AIX, PE,
# Darwin, other targets, zstd or multiarch.

# config.gcc's tm_file list for x86_64-*-linux*.
TM_FILES = [
    "vxworks-dummy.h",
    "i386/biarch64.h",
    "i386/i386.h",
    "i386/unix.h",
    "i386/att.h",
    "elfos.h",
    "gnu-user.h",
    "glibc-stdint.h",
    "i386/x86-64.h",
    "i386/gnu-user-common.h",
    "i386/gnu-user64.h",
    "linux.h",
    "linux-android.h",
    "i386/linux-common.h",
    "i386/linux64.h",
    "initfini-array.h",
]

CONFIG = struct(
    library_config_values = LIBRARY_CONFIG_VALUES,
    # libbacktrace's HAVE_DECL_ probes.
    backtrace_declarations = [
        "GETPAGESIZE",
        "STRNLEN",
    ],
    gcc_config_on = GCC_CONFIG_ON,
    gcc_config_values = GCC_CONFIG_VALUES,
    tm_files = TM_FILES,
    # GCC 13 already rejects -fsplit-stack for musl. musl has no split-stack
    # slot in its thread control block, so -mglibc must not enable it either.
    tm_epilogue = "#undef TARGET_THREAD_SPLIT_STACK_OFFSET\n",
    # libgcc/config.in values beside the shared ones.
    libgcc_config = {"HAVE_SYS_MMAN_H": "1"},
    # gcc/Makefile.in CFLAGS-<object> additions for objects new since GCC 10.
    object_defines = {
        "cp/module": [
            'HOST_MACHINE="' + TARGET + '"',
            'TARGET_MACHINE="' + TARGET + '"',
        ],
        "tree-diagnostic-client-data-hooks": ['TARGET_NAME="' + TARGET + '"'],
    },
)
