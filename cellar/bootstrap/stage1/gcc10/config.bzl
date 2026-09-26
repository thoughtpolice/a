# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# The configuration gcc_port writes for GCC 10.5, as configure would find it
# for a native musl 1.2.5 host with GNU binutils 2.30 and a static musl 1.2.5
# target.

# library-config.h values beside the shared LIBRARY_CONFIG_ON list.
LIBRARY_CONFIG_VALUES = {
    "SIZEOF_INT": "4",
    "SIZEOF_LONG": "8",
    "SIZEOF_LONG_LONG": "8",
    "SIZEOF_SIZE_T": "8",
    "SIZEOF_VOID_P": "8",
    "STACK_DIRECTION": "-1",
    "UNSIGNED_64BIT_TYPE": "unsigned long",
    "ICONV_CONST": "",
    "PACKAGE": "\"gcc\"",
    "PACKAGE_VERSION": "\"10.5.0\"",
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
    # Release checking (configure.ac:548-640, the "release" row) enables the
    # assert and runtime checks only. CHECKING_P=0 and ENABLE_ASSERT_CHECKING
    # already come from library-config.h.
    "ENABLE_RUNTIME_CHECKING",
    # --enable-decimal-float=bid (configure.ac:872-887).
    "ENABLE_DECIMAL_FLOAT",
    "ENABLE_DECIMAL_BID_FORMAT",
    # Upstream default; only the Fortran front end reads it
    # (configure.ac:6856-6863).
    "ENABLE_LIBQUADMATH_SUPPORT",
    # Host types and headers (C++ probes against musl and libstdc++).
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
    # From the libtool probe; only read under ENABLE_PLUGIN (system.h:684).
    "HAVE_DLFCN_H",
    # musl <termios.h> lacks TIOCGWINSZ; <sys/ioctl.h> has it (AC_HEADER_TIOCGWINSZ).
    "GWINSZ_IN_SYS_IOCTL",
    "HAVE_LC_MESSAGES",
    "HOST_HAS_F_SETLKW",
    # Host functions (configure.ac:1434-1437) musl provides.
    "HAVE_KILL",
    "HAVE_POPEN",
    "HAVE_NL_LANGINFO",
    "HAVE_MBSTOWCS",
    "HAVE_WORKING_MBSTOWCS",
    "HAVE_WCSWIDTH",
    "HAVE_SETLOCALE",
    "HAVE_MADVISE",
    "HAVE_MMAP_FILE",
    "HAVE_MMAP_ANON",
    "HAVE_MMAP_DEV_ZERO",
    # Target C library facts (configure.ac:6266-6317, 6448-6477).
    "TARGET_LIBC_PROVIDES_SSP",
    "TARGET_DL_ITERATE_PHDR",
    # GNU as 2.30, x86_64 ELF.
    "HAVE_GAS_BALIGN_AND_P2ALIGN",
    "HAVE_GAS_MAX_SKIP_P2ALIGN",
    "HAVE_GAS_SUBSECTION_ORDERING",
    "HAVE_GAS_WEAK",
    "HAVE_GAS_WEAKREF",
    "HAVE_GAS_HIDDEN",
    "HAVE_GAS_LOC_STMT",
    "HAVE_GAS_DISCRIMINATOR",
    # Only read by i386/bsd.h. GNU as accepts the 3-operand .lcomm on ELF.
    "HAVE_GAS_LCOMM_WITH_ALIGNMENT",
    "HAVE_AS_TLS",
    "HAVE_AS_DWARF2_DEBUG_LINE",
    # binutils 2.30 is the first release with .loc views; GCC emits
    # "view .LVUn" whenever -g is used, so check this with a gas test.
    "HAVE_AS_DWARF2_DEBUG_VIEW",
    "HAVE_AS_GDWARF2_DEBUG_FLAG",
    "HAVE_AS_GSTABS_DEBUG_FLAG",
    "HAVE_AS_DEBUG_PREFIX_MAP",
    "HAVE_AS_LINE_ZERO",
    "HAVE_AS_STABS_DIRECTIVE",
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
    # GNU ld 2.30.
    "HAVE_LD_EH_FRAME_HDR",
    "HAVE_LD_RO_RW_SECTION_MIXING",
    "HAVE_LD_STATIC_DYNAMIC",
    "HAVE_LD_DEMANGLE",
    "HAVE_LD_PIE",
    "HAVE_LD_EH_GC_SECTIONS",
    "HAVE_LD_AS_NEEDED",
    "HAVE_LD_BUILDID",
    "HAVE_LD_BNDPLT_SUPPORT",
    "HAVE_LD_PUSHPOPSTATE_SUPPORT",
]

GCC_CONFIG_VALUES = {
    # configure always defines these 0/1 switches (AC_DEFINE_UNQUOTED), and
    # code tests them with plain `if (X)` or `#if X`, so they must be defined
    # even when 0.
    "ENABLE_EXTRA_CHECKING": "0",
    "GATHER_STATISTICS": "0",
    "ENABLE_FIXED_POINT": "0",
    "ENABLE_VTABLE_VERIFY": "0",
    # configure enables the static analyzer unless --disable-analyzer.
    "ENABLE_ANALYZER": "1",
    "ENABLE_OFFLOADING": "0",
    "DEFAULT_STK_CLASH_GUARD_SIZE": "0",
    "HAVE_GNU_AS": "1",
    "HAVE_GNU_LD": "1",
    # config.gcc leaves default_gnu_indirect_function unset for musl
    # (config.gcc:3586-3587), and targhooks.c:637 returns this value, so it
    # must be defined.
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
    "HAVE_GAS_SHF_MERGE": "1",
    "HAVE_COMDAT_GROUP": "1",
    "HAVE_AS_IX86_INTERUNIT_MOVQ": "1",
    # 32-bit-only probes. The x86_64-only binutils cannot assemble or link
    # them, and every consumer is behind !TARGET_64BIT.
    "HAVE_AS_GOTOFF_IN_DATA": "0",
    "HAVE_AS_IX86_TLSLDMPLT": "0",
    "HAVE_AS_IX86_TLSLDM": "0",
    "HAVE_AS_IX86_GOT32X": "0",
    "HAVE_AS_IX86_TLS_GET_ADDR_GOT": "0",
    # gas 2.30 links the bundled zlib and accepts
    # --compress-debug-sections=zlib-gnu, which configure reports as 2.
    "HAVE_AS_COMPRESS_DEBUG": "2",
    "AS_COMPRESS_DEBUG_OPTION": "\"--compress-debug-sections\"",
    "AS_NO_COMPRESS_DEBUG_OPTION": "\"--nocompress-debug-sections\"",
    # Linker probes.
    "HAVE_LD_ALIGNED_SHF_MERGE": "1",
    "HAVE_LD_EH_FRAME_CIEV3": "1",
    "HAVE_LD_PIE_COPYRELOC": "1",
    "HAVE_LD_COMPRESS_DEBUG": "3",
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
    # musl has no getwd, mallinfo or ldgetname. system.h:483 then declares getwd.
    "HAVE_DECL_GETWD": "0",
    "HAVE_DECL_MALLINFO": "0",
    "HAVE_DECL_LDGETNAME": "0",
}

# config.gcc's tm_file list for x86_64-*-linux*.
TM_FILES = [
    "vxworks-dummy.h",
    "i386/biarch64.h",
    "i386/i386.h",
    "i386/unix.h",
    "i386/att.h",
    "dbxelf.h",
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
    backtrace_declarations = ["STRNLEN"],
    gcc_config_on = GCC_CONFIG_ON,
    gcc_config_values = GCC_CONFIG_VALUES,
    tm_files = TM_FILES,
    # musl has no split-stack slot in its thread control block.
    tm_epilogue = "#undef TARGET_CAN_SPLIT_STACK\n#undef TARGET_THREAD_SPLIT_STACK_OFFSET\n",
    libgcc_config = {},
    object_defines = {},
)
