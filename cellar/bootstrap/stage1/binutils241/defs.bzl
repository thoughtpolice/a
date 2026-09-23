# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "concatenate", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "exact_patch", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "bootstrap_artifact", "c_binary", "c_library", "c_object")
load("@cellar//bootstrap/stage1/binutils241:sources.bzl", "BINUTILS_HEADERS", "COMMON_HEADERS")

LIBIBERTY = [
    "regex",
    "cplus-dem",
    "cp-demangle",
    "md5",
    "sha1",
    "alloca",
    "argv",
    "bsearch_r",
    "choose-temp",
    "concat",
    "cp-demint",
    "crc32",
    "d-demangle",
    "dwarfnames",
    "dyn-string",
    "fdmatch",
    "fibheap",
    "filedescriptor",
    "filename_cmp",
    "floatformat",
    "fnmatch",
    "fopen_unlocked",
    "getopt",
    "getopt1",
    "getpwd",
    "getruntime",
    "hashtab",
    "hex",
    "lbasename",
    "lrealpath",
    "make-relative-prefix",
    "make-temp-file",
    "objalloc",
    "obstack",
    "partition",
    "pexecute",
    "physmem",
    "pex-common",
    "pex-one",
    "pex-unix",
    "vprintf-support",
    "rust-demangle",
    "safe-ctype",
    "simple-object",
    "simple-object-coff",
    "simple-object-elf",
    "simple-object-mach-o",
    "simple-object-xcoff",
    "sort",
    "spaces",
    "splay-tree",
    "stack-limit",
    "strerror",
    "strsignal",
    "timeval-utils",
    "unlink-if-ordinary",
    "xasprintf",
    "xatexit",
    "xexit",
    "xmalloc",
    "xmemdup",
    "xstrdup",
    "xstrerror",
    "xstrndup",
    "xvasprintf",
]

ZLIB = [
    "adler32",
    "compress",
    "crc32",
    "deflate",
    "gzclose",
    "gzlib",
    "gzread",
    "gzwrite",
    "infback",
    "inffast",
    "inflate",
    "inftrees",
    "trees",
    "uncompr",
    "zutil",
]

# The release's generated tables are comparison fixtures only.
ZLIB_FIXTURES = [
    "zlib/crc32.h",
    "zlib/trees.h",
    "zlib/inffixed.h",
]

ZLIB_HEADERS = [
    "zlib/zconf.h",
    "zlib/zlib.h",
    "zlib/zutil.h",
    "zlib/deflate.h",
    "zlib/gzguts.h",
    "zlib/inffast.h",
    "zlib/inflate.h",
    "zlib/inftrees.h",
]

LIBIBERTY_FILES = COMMON_HEADERS + ["libiberty/" + name + ".c" for name in LIBIBERTY] + [
    "COPYING",
    "COPYING3",
    "COPYING.LIB",
    "COPYING3.LIB",
]

BFD_HEADER_INPUTS = [
    "bfd/archive.c",
    "bfd/archures.c",
    "bfd/bfd-in.h",
    "bfd/bfd.c",
    "bfd/bfdio.c",
    "bfd/bfdwin.c",
    "bfd/cache.c",
    "bfd/coffcode.h",
    "bfd/compress.c",
    "bfd/corefile.c",
    "bfd/format.c",
    "bfd/hash.c",
    "bfd/libbfd-in.h",
    "bfd/libbfd.c",
    "bfd/libcoff-in.h",
    "bfd/linker.c",
    "bfd/opncls.c",
    "bfd/reloc.c",
    "bfd/section.c",
    "bfd/simple.c",
    "bfd/stab-syms.c",
    "bfd/stabs.c",
    "bfd/syms.c",
    "bfd/targets.c",
    "bfd/doc/chew.c",
    "bfd/doc/proto.str",
    "bfd/doc/header.sed",
    "bfd/elfxx-target.h",
    "bfd/targmatch.sed",
    "bfd/config.bfd",
    "bfd/version.h",
]

# bfd/Makefile.am BFD_H_FILES, LIBBFD_H_FILES and LIBCOFF_H_FILES.
BFD_HEADER_GROUPS = [
    (
        "bfd",
        [
            "bfd-in.h",
            "libbfd.c",
            "hash.c",
            "section.c",
            "syms.c",
            "archive.c",
            "archures.c",
            "bfd.c",
            "bfdio.c",
            "bfdwin.c",
            "cache.c",
            "compress.c",
            "corefile.c",
            "format.c",
            "linker.c",
            "opncls.c",
            "reloc.c",
            "simple.c",
            "stab-syms.c",
            "stabs.c",
            "targets.c",
        ],
        False,
    ),
    (
        "libbfd",
        [
            "libbfd-in.h",
            "libbfd.c",
            "bfd.c",
            "bfdio.c",
            "archive.c",
            "archures.c",
            "bfdwin.c",
            "cache.c",
            "hash.c",
            "linker.c",
            "opncls.c",
            "reloc.c",
            "section.c",
            "stabs.c",
            "targets.c",
        ],
        True,
    ),
    (
        "libcoff",
        [
            "libcoff-in.h",
            "coffcode.h",
        ],
        True,
    ),
]

# These release-generated headers are projected only as comparison fixtures.
HEADER_FIXTURES = [
    "bfd/bfd-in2.h",
    "bfd/libbfd.h",
    "bfd/libcoff.h",
]

BFD = [
    "archive",
    "archures",
    "bfd",
    "bfdio",
    "bfdwin",
    "cache",
    "coff-bfd",
    "compress",
    "corefile",
    "elf-properties",
    "format",
    "hash",
    "libbfd",
    "linker",
    "merge",
    "opncls",
    "reloc",
    "section",
    "simple",
    "stab-syms",
    "stabs",
    "syms",
    "targets",
    "binary",
    "ihex",
    "srec",
    "tekhex",
    "verilog",
    "archive64",
    "cpu-i386",
    "elf64-x86-64",
    "elfxx-x86",
    "elf-ifunc",
    "elf-vxworks",
    "elf64",
    # elf.c and elf64-x86-64.c take elf32_r_info and elf32_r_sym, which only
    # elf32.c defines, even with only ELF64 selected.
    "elf32",
    "elf",
    "elflink",
    "elf-attrs",
    "elf-strtab",
    "elf-eh-frame",
    "elf-sframe",
    "dwarf1",
    "dwarf2",
]

BFD_SOURCE_HEADERS = [
    "bfd/coff-bfd.h",
    "bfd/elf-bfd.h",
    "bfd/elf-linker-x86.h",
    "bfd/elf-linux-core.h",
    "bfd/elf-vxworks.h",
    "bfd/elfcode.h",
    "bfd/elfcore.h",
    "bfd/elfxx-x86.h",
    "bfd/genlink.h",
    "bfd/libaout.h",
    "bfd/libecoff.h",
    "bfd/plugin.h",
    "bfd/sysdep.h",
    "include/aout/aout64.h",
    "include/aout/ar.h",
    "include/aout/ranlib.h",
    "include/aout/stab.def",
    "include/aout/stab_gnu.h",
    "include/coff/ecoff.h",
    "include/coff/internal.h",
    "include/coff/sym.h",
    "include/elf/common.h",
    "include/elf/dwarf.h",
    "include/elf/external.h",
    "include/elf/i386.h",
    "include/elf/internal.h",
    "include/elf/reloc-macros.h",
    "include/elf/vxworks.h",
    "include/elf/x86-64.h",
    "include/opcode/i386.h",
    "include/sframe.h",
    "include/sframe-api.h",
    # ld includes libctf's interface unconditionally, even without libctf.
    "include/ctf-api.h",
    "include/ctf.h",
]

LIBSFRAME = [
    "sframe",
    "sframe-dump",
    "sframe-error",
]

# libsframe includes libctf's byte-swapping header even without libctf.
LIBSFRAME_FILES = ["libsframe/" + name + ".c" for name in LIBSFRAME] + [
    "libsframe/sframe-impl.h",
    "libctf/swap.h",
]

BFD_FILES = ["bfd/" + name + ".c" for name in BFD] + BFD_SOURCE_HEADERS

OPCODES = [
    "dis-buf",
    "disassemble",
    "dis-init",
    "i386-dis",
]

OPCODES_FILES = [
    "opcodes/dis-buf.c",
    "opcodes/disassemble.c",
    "opcodes/dis-init.c",
    "opcodes/i386-dis.c",
    "opcodes/sysdep.h",
    "opcodes/disassemble.h",
    "opcodes/opintl.h",
    "opcodes/i386-dis-evex.h",
    "opcodes/i386-dis-evex-len.h",
    "opcodes/i386-dis-evex-mod.h",
    "opcodes/i386-dis-evex-prefix.h",
    "opcodes/i386-dis-evex-reg.h",
    "opcodes/i386-dis-evex-w.h",
    "opcodes/i386-gen.c",
    "opcodes/i386-opc.h",
    "opcodes/i386-opc.tbl",
    "opcodes/i386-reg.tbl",
]

# Only gas includes the generated x86 tables.
I386_TABLES = [
    "i386-init.h",
    "i386-mnem.h",
    "i386-tbl.h",
]

OPCODE_FIXTURES = ["opcodes/" + name for name in I386_TABLES]

GAS = [
    "app",
    "as",
    "atof-generic",
    "codeview",
    "compress-debug",
    "cond",
    "depend",
    "dwarf2dbg",
    "dw2gencfi",
    "ecoff",
    "ehopt",
    "expr",
    "flonum-copy",
    "flonum-konst",
    "flonum-mult",
    "frags",
    "gen-sframe",
    "hash",
    "input-file",
    "input-scrub",
    "listing",
    "literal",
    "macro",
    "messages",
    "output-file",
    "read",
    "remap",
    "sb",
    "sframe-opt",
    "stabs",
    "subsegs",
    "symbols",
    "write",
    "config/tc-i386",
    "config/obj-elf",
    "config/atof-ieee",
]

GAS_HEADERS = [
    "gas/as.h",
    "gas/asintl.h",
    "gas/bignum.h",
    "gas/bit_fix.h",
    "gas/cgen.h",
    "gas/codeview.h",
    "gas/compress-debug.h",
    "gas/dwarf2dbg.h",
    "gas/dw2gencfi.h",
    "gas/ecoff.h",
    "gas/emul-target.h",
    "gas/emul.h",
    "gas/expr.h",
    "gas/flonum.h",
    "gas/frags.h",
    "gas/gen-sframe.h",
    "gas/hash.h",
    "gas/input-file.h",
    "gas/itbl-lex.h",
    "gas/itbl-ops.h",
    "gas/listing.h",
    "gas/macro.h",
    "gas/obj.h",
    "gas/output-file.h",
    "gas/read.h",
    "gas/sb.h",
    "gas/subsegs.h",
    "gas/symbols.h",
    "gas/tc.h",
    "gas/write.h",
    "gas/config/tc-i386.h",
    "gas/config/obj-elf.h",
    "gas/config/te-linux.h",
    "gas/config/tc-i386-intel.c",
]

# flonum-konst.c is regenerated from integer arithmetic below.
GAS_FILES = ["gas/" + name + ".c" for name in GAS if name != "flonum-konst"] + GAS_HEADERS

LD = [
    "ldgram",
    "ldlex-wrapper",
    "lexsup",
    "ldlang",
    "mri",
    "ldctor",
    "ldmain",
    "ldwrite",
    "ldexp",
    "ldemul",
    "ldver",
    "ldmisc",
    "ldfile",
    "ldcref",
    "ldbuildid",
    "eelf_x86_64",
    "ldelf",
    "ldelfgen",
]

LD_HEADERS = [
    "ld/ld.h",
    "ld/ldctor.h",
    "ld/ldelf.h",
    "ld/ldelfgen.h",
    "ld/ldemul.h",
    "ld/ldexp.h",
    "ld/ldfile.h",
    "ld/ldlang.h",
    "ld/ldlex.h",
    "ld/ldmain.h",
    "ld/ldmisc.h",
    "ld/ldver.h",
    "ld/ldwrite.h",
    "ld/mri.h",
    "ld/elf-hints-local.h",
    "ld/ldbuildid.h",
    "ld/sysdep.h",
]

LD_GENERATOR_INPUTS = [
    "ld/genscripts.sh",
    "ld/genscrba.sh",
    "ld/emultempl/astring.sed",
    "ld/emultempl/elf.em",
    "ld/emultempl/elf-generic.em",
    "ld/emultempl/elf-x86.em",
    "ld/emultempl/emulation.em",
    "ld/scripttempl/elf.sc",
    "ld/scripttempl/misc-sections.sc",
    "ld/scripttempl/DWARF.sc",
    "ld/emulparams/elf_x86_64.sh",
    "ld/emulparams/plt_unwind.sh",
    "ld/emulparams/extern_protected_data.sh",
    "ld/emulparams/dynamic_undefined_weak.sh",
    "ld/emulparams/reloc_overflow.sh",
    "ld/emulparams/call_nop.sh",
    "ld/emulparams/cet.sh",
    "ld/emulparams/x86-report-relative.sh",
    "ld/emulparams/x86-64-level.sh",
    "ld/emulparams/x86-64-lam.sh",
    "ld/emulparams/static.sh",
    "ld/emulparams/dt-relr.sh",
]

LD_FILES = ["ld/" + name + ".c" for name in LD if name not in [
    "ldgram",
    "eelf_x86_64",
]] + LD_HEADERS + LD_GENERATOR_INPUTS + [
    "ld/ldgram.y",
    "ld/ldlex.l",
]

BINUTILS_PROGRAMS = {
    "size": [
        "size",
        "bucomm",
        "version",
        "filemode",
    ],
    "objcopy": [
        "objcopy",
        "not-strip",
        "rename",
        "rddbg",
        "debug",
        "stabs",
        "rdcoff",
        "wrstabs",
        "bucomm",
        "version",
        "filemode",
    ],
    "strings": [
        "strings",
        "bucomm",
        "version",
        "filemode",
    ],
    "readelf": [
        "readelf",
        "version",
        "unwind-ia64",
        "dwarf",
        "demanguse",
        "elfcomm",
    ],
    "elfedit": [
        "elfedit",
        "version",
        "elfcomm",
    ],
    "strip": [
        "objcopy",
        "is-strip",
        "rename",
        "rddbg",
        "debug",
        "stabs",
        "rdcoff",
        "wrstabs",
        "bucomm",
        "version",
        "filemode",
    ],
    "nm": [
        "nm",
        "demanguse",
        "bucomm",
        "version",
        "filemode",
    ],
    "objdump": [
        "objdump",
        "dwarf",
        "prdbg",
        "demanguse",
        "rddbg",
        "debug",
        "stabs",
        "rdcoff",
        "bucomm",
        "version",
        "filemode",
        "elfcomm",
    ],
    "c++filt": [
        "cxxfilt",
        "bucomm",
        "version",
        "filemode",
    ],
    "ar": [
        "arparse",
        "arlex",
        "ar",
        "not-ranlib",
        "arsup",
        "rename",
        "binemul",
        "emul_vanilla",
        "bucomm",
        "version",
        "filemode",
    ],
    "ranlib": [
        "ar",
        "is-ranlib",
        "arparse",
        "arlex",
        "arsup",
        "rename",
        "binemul",
        "emul_vanilla",
        "bucomm",
        "version",
        "filemode",
    ],
    "addr2line": [
        "addr2line",
        "bucomm",
        "version",
        "filemode",
    ],
}

BINUTILS = sorted({source: None for sources in BINUTILS_PROGRAMS.values() for source in sources})

BINUTILS_FILES = [
    "binutils/addr2line.c",
    "binutils/ar.c",
    "binutils/arsup.c",
    "binutils/binemul.c",
    "binutils/bucomm.c",
    "binutils/cxxfilt.c",
    "binutils/debug.c",
    "binutils/demanguse.c",
    "binutils/dwarf.c",
    "binutils/elfcomm.c",
    "binutils/elfedit.c",
    "binutils/emul_vanilla.c",
    "binutils/filemode.c",
    "binutils/is-ranlib.c",
    "binutils/is-strip.c",
    "binutils/nm.c",
    "binutils/not-ranlib.c",
    "binutils/not-strip.c",
    "binutils/objcopy.c",
    "binutils/objdump.c",
    "binutils/prdbg.c",
    "binutils/rdcoff.c",
    "binutils/rddbg.c",
    "binutils/readelf.c",
    "binutils/rename.c",
    "binutils/size.c",
    "binutils/stabs.c",
    "binutils/strings.c",
    "binutils/unwind-ia64.c",
    "binutils/version.c",
    "binutils/wrstabs.c",
    "binutils/arsup.h",
    "binutils/binemul.h",
    "binutils/bucomm.h",
    "binutils/budbg.h",
    "binutils/debug.h",
    "binutils/demanguse.h",
    "binutils/dwarf.h",
    "binutils/elfcomm.h",
    "binutils/objdump.h",
    "binutils/sysdep.h",
    "binutils/unwind-ia64.h",
    "binutils/arparse.y",
    "binutils/arlex.l",
]

GPROF = [
    "basic_blocks",
    "call_graph",
    "cg_arcs",
    "cg_dfn",
    "cg_print",
    "corefile",
    "gmon_io",
    "gprof",
    "hertz",
    "hist",
    "source",
    "search_list",
    "symtab",
    "sym_ids",
    "utils",
    "i386",
]

GPROF_BLURBS = [
    "flat_bl",
    "bsd_callg_bl",
    "fsf_callg_bl",
]

GPROF_FILES = [
    "gprof/basic_blocks.c",
    "gprof/call_graph.c",
    "gprof/cg_arcs.c",
    "gprof/cg_dfn.c",
    "gprof/cg_print.c",
    "gprof/corefile.c",
    "gprof/gmon_io.c",
    "gprof/gprof.c",
    "gprof/hertz.c",
    "gprof/hist.c",
    "gprof/source.c",
    "gprof/search_list.c",
    "gprof/symtab.c",
    "gprof/sym_ids.c",
    "gprof/utils.c",
    "gprof/i386.c",
    "gprof/basic_blocks.h",
    "gprof/call_graph.h",
    "gprof/cg_arcs.h",
    "gprof/cg_dfn.h",
    "gprof/cg_print.h",
    "gprof/corefile.h",
    "gprof/gmon.h",
    "gprof/gmon_io.h",
    "gprof/gmon_out.h",
    "gprof/gprof.h",
    "gprof/hertz.h",
    "gprof/hist.h",
    "gprof/search_list.h",
    "gprof/source.h",
    "gprof/sym_ids.h",
    "gprof/symtab.h",
    "gprof/utils.h",
    "gprof/flat_bl.m",
    "gprof/bsd_callg_bl.m",
    "gprof/fsf_callg_bl.m",
    "gprof/gen-c-prog.awk",
]

FILES = ZLIB_FIXTURES + LIBSFRAME_FILES + GPROF_FILES + BINUTILS_FILES + BINUTILS_HEADERS + LD_FILES + GAS_FILES + OPCODES_FILES + OPCODE_FIXTURES + LIBIBERTY_FILES + ZLIB_HEADERS + ["zlib/" + name + ".c" for name in ZLIB] + BFD_HEADER_INPUTS + HEADER_FIXTURES + [path for path in BFD_FILES if path not in BFD_HEADER_INPUTS]

LIBIBERTY_ON = [
    "STDC_HEADERS",
    "TIME_WITH_SYS_TIME",
    "HAVE_ALLOCA_H",
    "HAVE_ASPRINTF",
    "HAVE_ATEXIT",
    "HAVE_BASENAME",
    "HAVE_BCMP",
    "HAVE_BCOPY",
    "HAVE_BSEARCH",
    "HAVE_BZERO",
    "HAVE_CALLOC",
    "HAVE_CLOCK",
    "HAVE_DUP3",
    "HAVE_FCNTL_H",
    "HAVE_FFS",
    "HAVE_FORK",
    "HAVE_GETCWD",
    "HAVE_GETPAGESIZE",
    "HAVE_GETRLIMIT",
    "HAVE_GETRUSAGE",
    "HAVE_GETTIMEOFDAY",
    "HAVE_INDEX",
    "HAVE_INSQUE",
    "HAVE_INTPTR_T",
    "HAVE_INTTYPES_H",
    "HAVE_LIMITS_H",
    "HAVE_LONG_LONG",
    "HAVE_MALLOC_H",
    "HAVE_MEMCHR",
    "HAVE_MEMCMP",
    "HAVE_MEMCPY",
    "HAVE_MEMMEM",
    "HAVE_MEMMOVE",
    "HAVE_MEMORY_H",
    "HAVE_MEMSET",
    "HAVE_MKSTEMPS",
    "HAVE_MMAP",
    "HAVE_PIPE2",
    "HAVE_PSIGNAL",
    "HAVE_PUTENV",
    "HAVE_RANDOM",
    "HAVE_REALPATH",
    "HAVE_RENAME",
    "HAVE_RINDEX",
    "HAVE_SBRK",
    "HAVE_SETENV",
    "HAVE_SETRLIMIT",
    "HAVE_SNPRINTF",
    "HAVE_STDINT_H",
    "HAVE_STDIO_EXT_H",
    "HAVE_STDLIB_H",
    "HAVE_STPCPY",
    "HAVE_STPNCPY",
    "HAVE_STRCASECMP",
    "HAVE_STRCHR",
    "HAVE_STRDUP",
    "HAVE_STRERROR",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_STRNCASECMP",
    "HAVE_STRNDUP",
    "HAVE_STRNLEN",
    "HAVE_STRRCHR",
    "HAVE_STRSIGNAL",
    "HAVE_STRSTR",
    "HAVE_STRTOD",
    "HAVE_STRTOL",
    "HAVE_STRTOLL",
    "HAVE_STRTOUL",
    "HAVE_STRTOULL",
    "HAVE_STRVERSCMP",
    "HAVE_SYSCONF",
    "HAVE_SYS_FILE_H",
    "HAVE_SYS_MMAN_H",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_PRCTL_H",
    "HAVE_SYS_RESOURCE_H",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_SYSINFO_H",
    "HAVE_SYS_TIME_H",
    "HAVE_SYS_TYPES_H",
    "HAVE_SYS_WAIT_H",
    "HAVE_TIMES",
    "HAVE_TIME_H",
    "HAVE_TMPNAM",
    "HAVE_UINTPTR_T",
    "HAVE_UNISTD_H",
    "HAVE_VASPRINTF",
    "HAVE_VFORK",
    "HAVE_VFPRINTF",
    "HAVE_VPRINTF",
    "HAVE_VSPRINTF",
    "HAVE_WAIT3",
    "HAVE_WAIT4",
    "HAVE_WAITPID",
    "HAVE_WORKING_FORK",
    "HAVE_WORKING_VFORK",
    "HAVE___FSETLOCKING",
    "HAVE_DECL_ASPRINTF",
    "HAVE_DECL_CALLOC",
    "HAVE_DECL_FFS",
    "HAVE_DECL_GETENV",
    "HAVE_DECL_GETOPT",
    "HAVE_DECL_MALLOC",
    "HAVE_DECL_REALLOC",
    "HAVE_DECL_SBRK",
    "HAVE_DECL_SNPRINTF",
    "HAVE_DECL_STRNLEN",
    "HAVE_DECL_STRTOL",
    "HAVE_DECL_STRTOLL",
    "HAVE_DECL_STRTOUL",
    "HAVE_DECL_STRTOULL",
    "HAVE_DECL_STRVERSCMP",
    "HAVE_DECL_VASPRINTF",
    "HAVE_DECL_VSNPRINTF",
]

LIBIBERTY_VALUES = {
    # musl 1.2.5 declares basename only in <libgen.h>, so libiberty.h declares it.
    "HAVE_DECL_BASENAME": "0",
    "SIZEOF_INT": "4",
    "SIZEOF_LONG": "8",
    "SIZEOF_LONG_LONG": "8",
    "SIZEOF_SIZE_T": "8",
    "STACK_DIRECTION": "-1",
    "UNSIGNED_64BIT_TYPE": "unsigned long",
    "PACKAGE": '"binutils"',
    "PACKAGE_VERSION": '"2.41"',
}

# These source changes apply unchanged to 2.41, so the binutils 2.30 port's
# copies are used, as are its tests.
SHARED_PATCHES = [
    "gen-input-dir",
    "gen-local-dir",
    "gen-registers-path",
    "gprof-bounds",
    "gprof-displacement",
    "gprof-next-call",
    "ld-stringify",
    "ld-template-lines",
]

def _patch(name):
    package = "binutils" if name in SHARED_PATCHES else "binutils241"
    return "cellar//bootstrap/stage1/" + package + ":patches/" + name + ".patch"

def binutils_stage(
        toolchain,
        libc_headers,
        crt,
        crtn,
        libc,
        cflags,
        tools,
        preprocessor,
        bfd_test_object,
        action_env = {},
        source_alias = None):
    """Declares the native binutils 2.41 graph for one predecessor toolchain.

    The calling package must declare the `binutils-2.41` source target, whose
    subtargets are the pinned release paths in FILES. `tools` maps bash, bison,
    cat, cmp, flex, gawk, mkdir, rm and sed to the generator executables, and
    `preprocessor` is a C compiler command that accepts -E.

    Without `source_alias`, component sources compile in place with their
    directories as `includes`. With it, each source tree is aliased to a stable
    logical path and its directories become `-Isource/...` flags.
    """

    def source_attrs(tree, includes, logical_source, logical_includes = [], tree_flags = []):
        if source_alias == None:
            return {
                "flags": cflags,
                "includes": includes,
            }
        flags = []
        for include in includes:
            if include == tree:
                flags.append("-Isource/.")
            elif include.startswith(tree + "["):
                flags.append("-Isource/" + include[len(tree) + 1:-1])
            else:
                flags.append("-I$(location " + include + ")")
        return {
            "flags": flags + tree_flags + cflags,
            "logical_includes": logical_includes,
            "logical_source": logical_source,
            "source_alias": source_alias,
            "source_tree": tree,
        }

    write_file(
        name = "libiberty-config.h",
        content = "#ifndef _GNU_SOURCE\n#define _GNU_SOURCE 1\n#endif\n" + "\n".join(["#define " + name + " 1" for name in LIBIBERTY_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in LIBIBERTY_VALUES.items()]) + "\n",
    )

    exact_patch(
        name = "make-temp-file.c",
        src = ":binutils-2.41[libiberty/make-temp-file.c]",
        patch = "cellar//bootstrap/stage1/binutils241:patches/tmpdir.patch",
    )

    # The upstream commented C generator is the source of the CRC table. Its
    # published table is removed before the library consumes the prepared source.
    [
        generate(
            name = name,
            args = flags + [
                script,
                "$(location :binutils-2.41[libiberty/crc32.c])",
            ],
            capture = "cellar//bootstrap/stage1/tools:capture",
            tool = tools["sed"],
        )
        for name, flags, script in [
            (
                "crcgen.c",
                ["-n"],
                "/^   #include <stdio.h>/,/^   \\}$/p",
            ),
            ("crc32-prefix", [], "/crc_v3\\.txt/{n; q}"),
            ("crc32-suffix", [], "1,/^};$/d"),
        ]
    ]

    c_object(
        name = "crcgen.o",
        src = ":crcgen.c",
        flags = cflags,
        headers = [libc_headers],
        object_name = "crcgen.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "crcgen",
        libraries = libc,
        objects = crt + [":crcgen.o"] + crtn,
        output = "crcgen",
        toolchain = toolchain,
    )

    generate(
        name = "crc32-table",
        capture = "cellar//bootstrap/stage1/tools:capture",
        tool = ":crcgen",
    )

    concatenate(
        name = "crc32.c",
        inputs = [
            ":crc32-prefix",
            ":crc32-table",
            ":crc32-suffix",
        ],
        tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
    )

    filegroup(
        name = "libiberty-source",
        srcs = {path: ":binutils-2.41[" + path + "]" for path in LIBIBERTY_FILES} | {
            "libiberty/config.h": ":libiberty-config.h",
            "libiberty/crc32.c": ":crc32.c",
            "libiberty/make-temp-file.c": ":make-temp-file.c",
        },
    )

    [
        c_object(
            name = "iberty-" + name + ".o",
            src = ":libiberty-source[libiberty/" + name + ".c]",
            defines = ["HAVE_CONFIG_H=1"],
            headers = [
                ":libiberty-source",
                libc_headers,
            ],
            object_name = "ib{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":libiberty-source",
                # do not sort
                includes = [
                    ":libiberty-source[libiberty]",
                    ":libiberty-source[include]",
                ],
                logical_source = "libiberty/" + name + ".c",
            )
        )
        for i, name in enumerate(LIBIBERTY)
    ]

    c_library(
        name = "libiberty.a",
        objects = [":iberty-" + name + ".o" for name in LIBIBERTY],
        output = "libiberty.a",
        toolchain = toolchain,
    )

    c_object(
        name = "libiberty-test.o",
        src = "cellar//bootstrap/stage1/binutils:tests/libiberty.c",
        flags = cflags,
        headers = [
            ":libiberty-source",
            libc_headers,
        ],
        # do not sort
        includes = [
            ":libiberty-source[libiberty]",
            ":libiberty-source[include]",
        ],
        object_name = "test.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "libiberty-test-bin",
        libraries = [":libiberty.a"] + libc,
        objects = crt + [":libiberty-test.o"] + crtn,
        output = "libiberty-test",
        toolchain = toolchain,
    )

    command_test(
        name = "libiberty-test",
        tool = ":libiberty-test-bin",
    )

    command_test(
        name = "libiberty-missing-tmpdir",
        args = [
            "1",
            "$(exe :libiberty-test-bin)",
            "temp",
        ],
        env = {"TMPDIR": ""},
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    )

    generate(
        name = "libiberty-temp-output",
        args = ["temp"],
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        env = {"TMPDIR": "."} | action_env,
        files = ["passed"],
        tool = ":libiberty-test-bin",
    )

    write_file(
        name = "passed",
        content = "passed\n",
    )

    command_test(
        name = "libiberty-temp",
        args = [
            "$(location :libiberty-temp-output[passed])",
            "$(location :passed)",
        ],
        tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
    )

    # Bootstrap table writers use upstream's runtime-generation modes. None of
    # crc32.h, trees.h or inffixed.h is projected from the release archive.
    filegroup(
        name = "zlib-bootstrap-source",
        srcs = {path: ":binutils-2.41[" + path + "]" for path in ZLIB_HEADERS + ["zlib/" + name + ".c" for name in ZLIB]},
    )

    [
        [
            c_object(
                name = stage + "-" + name + ".o",
                src = ":" + source + "[zlib/" + name + ".c]",
                defines = [
                    "_GNU_SOURCE=1",
                    "HAVE_UNISTD_H=1",
                ] + extra,
                flags = cflags,
                headers = [
                    ":" + source,
                    libc_headers,
                ],
                includes = [":" + source + "[zlib]"],
                object_name = "z{}.o".format(i),
                toolchain = toolchain,
            )
            for i, name in enumerate(ZLIB)
        ] + [
            c_library(
                name = stage + ".a",
                objects = [":" + stage + "-" + name + ".o" for name in ZLIB],
                output = "libz.a",
                toolchain = toolchain,
            ),
        ]
        for stage, source, extra in [
            (
                "zlib-bootstrap",
                "zlib-bootstrap-source",
                [
                    "GEN_TREES_H=1",
                    "DYNAMIC_CRC_TABLE=1",
                    "MAKEFIXED=1",
                    "BUILDFIXED=1",
                ],
            ),
            ("libz", "zlib-source", []),
        ]
    ]

    c_object(
        name = "zlib-tables.o",
        src = "cellar//bootstrap/stage1/binutils241:generators/zlib-tables.c",
        flags = (["-Isource/include"] if source_alias != None else []) + cflags,
        headers = [
            ":zlib-bootstrap-source",
            libc_headers,
        ],
        includes = [":zlib-bootstrap-source[zlib]"],
        object_name = "ztables.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "zlib-tables",
        libraries = [":zlib-bootstrap.a"] + libc,
        objects = crt + [":zlib-tables.o"] + crtn,
        output = "zlib-tables",
        toolchain = toolchain,
    )

    [
        generate(
            name = "zlib-" + name,
            args = [name],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            files = [name],
            tool = ":zlib-tables",
        )
        for name in [
            "trees.h",
            "inffixed.h",
        ]
    ]

    # zlib 1.2.12's crc32.c provides a main that writes crc32.h itself.
    c_object(
        name = "zlib-crc32-gen.o",
        src = ":zlib-bootstrap-source[zlib/crc32.c]",
        defines = [
            "_GNU_SOURCE=1",
            "HAVE_UNISTD_H=1",
            "MAKECRCH=1",
        ],
        flags = cflags,
        headers = [
            ":zlib-bootstrap-source",
            libc_headers,
        ],
        includes = [":zlib-bootstrap-source[zlib]"],
        object_name = "crc32gen.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "zlib-crc32-gen",
        libraries = libc,
        objects = crt + [":zlib-crc32-gen.o"] + crtn,
        output = "zlib-crc32-gen",
        toolchain = toolchain,
    )

    generate(
        name = "zlib-crc32.h",
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        files = ["crc32.h"],
        tool = ":zlib-crc32-gen",
    )

    [
        command_test(
            name = "zlib-" + name + "-regeneration",
            args = [
                "$(location :zlib-" + name + "[" + name + "])",
                "$(location :binutils-2.41[zlib/" + name + "])",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        )
        for name in [
            "crc32.h",
            "trees.h",
            "inffixed.h",
        ]
    ]

    filegroup(
        name = "zlib-source",
        srcs = {path: ":binutils-2.41[" + path + "]" for path in ZLIB_HEADERS + ["zlib/" + name + ".c" for name in ZLIB]} | {"zlib/" + name: ":zlib-" + name + "[" + name + "]" for name in [
            "crc32.h",
            "trees.h",
            "inffixed.h",
        ]},
    )

    c_object(
        name = "zlib-test.o",
        src = "cellar//bootstrap/stage1/binutils:tests/zlib.c",
        flags = cflags,
        headers = [
            ":zlib-source",
            libc_headers,
        ],
        includes = [":zlib-source[zlib]"],
        object_name = "ztest.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "zlib-test-bin",
        libraries = [":libz.a"] + libc,
        objects = crt + [":zlib-test.o"] + crtn,
        output = "zlib-test",
        toolchain = toolchain,
    )

    command_test(
        name = "zlib-memory",
        tool = ":zlib-test-bin",
    )

    generate(
        name = "zlib-file-output",
        args = ["file"],
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        files = ["passed"],
        tool = ":zlib-test-bin",
    )

    command_test(
        name = "zlib-file",
        args = [
            "$(location :zlib-file-output[passed])",
            "$(location :passed)",
        ],
        tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
    )

    # Native BFD ABI configuration, independent of compiler output paths.
    BFD_NATIVE = {
        "supports_plugins": "0",
        "wordsize": "64",
        "bfd_default_target_size": "64",
        "bfd_file_ptr": "int64_t",
        "bfd_ufile_ptr": "uint64_t",
    }

    filegroup(
        name = "bfd-header-source",
        srcs = {path: ":binutils-2.41[" + path + "]" for path in BFD_HEADER_INPUTS + COMMON_HEADERS},
    )

    c_object(
        name = "chew.o",
        src = ":bfd-header-source[bfd/doc/chew.c]",
        headers = [
            ":bfd-header-source",
            libc_headers,
        ],
        object_name = "chew.o",
        toolchain = toolchain,
        **source_attrs(
            tree = ":bfd-header-source",
            includes = [":bfd-header-source[include]"],
            logical_source = "bfd/doc/chew.c",
        )
    )

    c_binary(
        name = "chew",
        libraries = libc,
        objects = crt + [":chew.o"] + crtn,
        output = "chew",
        toolchain = toolchain,
    )

    [
        [
            write_file(
                name = group + "-header-inputs",
                content = " ".join(sources + ["doc/header.sed"]) + "\n",
            ),
            generate(
                name = group + "-header-comment",
                args = [
                    "-f",
                    "$(location :bfd-header-source[bfd/doc/header.sed])",
                    "$(location :" + group + "-header-inputs)",
                ],
                capture = "cellar//bootstrap/stage1/tools:capture",
                tool = tools["sed"],
            ),
            write_file(
                name = group + "-header-end",
                content = "#ifdef __cplusplus\n}\n#endif\n#endif\n",
            ),
        ] + [
            [
                write_file(
                    name = group + "-" + path + "-comment",
                    content = "/* Extracted from " + path + ".  */\n",
                ),
                generate(
                    name = group + "-" + path + "-decls",
                    args = (["-i"] if internal else []) + [
                        "-f",
                        "$(location :bfd-header-source[bfd/doc/proto.str])",
                    ],
                    capture = "cellar//bootstrap/stage1/tools:capture",
                    stdin = ":bfd-header-source[bfd/" + path + "]",
                    tool = ":chew",
                ),
            ]
            for path in sources[1:]
        ] + [
            concatenate(
                name = group + "-header-raw",
                inputs = [
                    ":" + group + "-header-comment",
                    ":bfd-header-source[bfd/" + sources[0] + "]",
                ] + [":" + group + "-" + path + suffix for path in sources[1:] for suffix in [
                    "-comment",
                    "-decls",
                ]] + [":" + group + "-header-end"],
                tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
            ),
            command_test(
                name = group + "-header-regeneration",
                args = [
                    "$(location :" + group + "-header-raw)",
                    "$(location :binutils-2.41[bfd/" + ("bfd-in2" if group == "bfd" else group) + ".h])",
                ],
                tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
            ),
        ]
        for group, sources, internal in BFD_HEADER_GROUPS
    ]

    generate(
        name = "bfd.h",
        args = [arg for name, value in BFD_NATIVE.items() for arg in [
            "-e",
            "s|@" + name + "@|" + value + "|g",
        ]] + ["$(location :bfd-header-raw)"],
        capture = "cellar//bootstrap/stage1/tools:capture",
        tool = tools["sed"],
    )

    generate(
        name = "elf64-target.h",
        args = [
            "s/NN/64/g",
            "$(location :bfd-header-source[bfd/elfxx-target.h])",
        ],
        capture = "cellar//bootstrap/stage1/tools:capture",
        tool = tools["sed"],
    )

    generate(
        name = "targmatch.h",
        args = [
            "-f",
            "$(location :bfd-header-source[bfd/targmatch.sed])",
            "$(location :bfd-header-source[bfd/config.bfd])",
        ],
        capture = "cellar//bootstrap/stage1/tools:capture",
        tool = tools["sed"],
    )

    BFD_VERSION = {
        "bfd_version": "241000000",
        "bfd_version_string": '\"2.41\"',
        "bfd_version_package": '\"\"',
        "report_bugs_to": '\"https://www.sourceware.org/bugzilla/\"',
    }

    generate(
        name = "bfdver.h",
        args = [arg for name, value in BFD_VERSION.items() for arg in [
            "-e",
            "s|@" + name + "@|" + value + "|g",
        ]] + ["$(location :bfd-header-source[bfd/version.h])"],
        capture = "cellar//bootstrap/stage1/tools:capture",
        tool = tools["sed"],
    )

    filegroup(
        name = "bfd-headers",
        srcs = {path: ":bfd-header-source[" + path + "]" for path in COMMON_HEADERS} | {"bfd/" + name: ":" + name for name in [
            "bfd.h",
            "bfdver.h",
            "elf64-target.h",
            "targmatch.h",
        ]} | {
            "bfd/libbfd.h": ":libbfd-header-raw",
            "bfd/libcoff.h": ":libcoff-header-raw",
        },
    )

    c_object(
        name = "bfd-header-test.o",
        src = "cellar//bootstrap/stage1/binutils241:tests/bfd-headers.c",
        defines = ["PACKAGE_VERSION=\"2.41\""],
        flags = cflags,
        headers = [
            ":bfd-headers",
            libc_headers,
        ],
        includes = [
            ":bfd-headers[bfd]",
            ":bfd-headers[include]",
        ],
        object_name = "headers.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "bfd-header-test-bin",
        libraries = libc,
        objects = crt + [":bfd-header-test.o"] + crtn,
        output = "bfd-headers-test",
        toolchain = toolchain,
    )

    command_test(
        name = "bfd-native-headers",
        tool = ":bfd-header-test-bin",
    )

    BFD_ON = [
        "HAVE_DLFCN_H",
        "HAVE_FCNTL",
        "HAVE_FCNTL_H",
        "HAVE_FDOPEN",
        "HAVE_FILENO",
        "HAVE_FSEEKO",
        "HAVE_FTELLO",
        "HAVE_GETGID",
        "HAVE_GETPAGESIZE",
        "HAVE_GETRLIMIT",
        "HAVE_GETUID",
        "HAVE_HIDDEN",
        "HAVE_INTTYPES_H",
        "HAVE_MADVISE",
        "HAVE_MEMORY_H",
        "HAVE_MMAP",
        "HAVE_MPROTECT",
        "HAVE_PRPSINFO_T",
        "HAVE_PRPSINFO_T_PR_PID",
        "HAVE_PRSTATUS_T",
        "HAVE_STDINT_H",
        "HAVE_STDLIB_H",
        "HAVE_STRINGS_H",
        "HAVE_STRING_H",
        "HAVE_SYSCONF",
        "HAVE_SYS_FILE_H",
        "HAVE_SYS_PARAM_H",
        "HAVE_SYS_PROCFS_H",
        "HAVE_SYS_RESOURCE_H",
        "HAVE_SYS_STAT_H",
        "HAVE_SYS_TYPES_H",
        "HAVE_UNISTD_H",
        "STDC_HEADERS",
        "USE_MMAP",
        "USE_SECUREPLT",
        "_STRUCTURED_PROC",
        "HAVE_DECL_ASPRINTF",
        "HAVE_DECL_FFS",
        "HAVE_DECL_FSEEKO",
        "HAVE_DECL_FTELLO",
        "HAVE_DECL_STPCPY",
        "HAVE_DECL_STRNLEN",
        "HAVE_DECL_VASPRINTF",
    ]

    # musl 1.2.5 has no LFS64 symbols, fls or basename declaration in string.h.
    BFD_VALUES = {
        "_GNU_SOURCE": "1",
        "PACKAGE": '"bfd"',
        "PACKAGE_VERSION": '"2.41"',
        "VERSION": '"2.41"',
        "SIZEOF_INT": "4",
        "SIZEOF_LONG": "8",
        "SIZEOF_LONG_LONG": "8",
        "SIZEOF_OFF_T": "8",
        "SIZEOF_VOID_P": "8",
        "DEFAULT_LD_Z_SEPARATE_CODE": "1",
        "HAVE_DECL_BASENAME": "0",
        "HAVE_DECL_FOPEN64": "0",
        "HAVE_DECL_FSEEKO64": "0",
        "HAVE_DECL_FTELLO64": "0",
        "HAVE_DECL____LC_CODEPAGE_FUNC": "0",
        "BINDIR": '"/nonexistent-bootstrap-binutils/bin"',
        "DEBUGDIR": '"/nonexistent-bootstrap-binutils/debug"',
        "DEFAULT_VECTOR": "x86_64_elf64_vec",
        "SELECT_VECS": "&x86_64_elf64_vec",
        "HAVE_x86_64_elf64_vec": "1",
        "SELECT_ARCHITECTURES": "&bfd_i386_arch",
    }

    write_file(
        name = "bfd-config.h",
        content = "\n".join(["#define " + name + " 1" for name in BFD_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in BFD_VALUES.items()]) + "\n",
    )

    # The first vector is native ELF64. Subsequent vectors in this translation
    # unit implement other OS ABIs and x32, which are outside the native port.
    generate(
        name = "elf64-x86-64.c",
        args = [
            '/^[#]include "elf64-target.h"/q',
            "$(location :binutils-2.41[bfd/elf64-x86-64.c])",
        ],
        capture = "cellar//bootstrap/stage1/tools:capture",
        tool = tools["sed"],
    )

    filegroup(
        name = "bfd-source",
        srcs = {path: ":binutils-2.41[" + path + "]" for path in BFD_FILES + COMMON_HEADERS} | {"bfd/" + name: ":bfd-headers[bfd/" + name + "]" for name in [
            "bfd.h",
            "bfdver.h",
            "elf64-target.h",
            "targmatch.h",
            "libbfd.h",
            "libcoff.h",
        ]} | {
            "bfd/config.h": ":bfd-config.h",
            "bfd/elf64-x86-64.c": ":elf64-x86-64.c",
        },
    )

    [
        c_object(
            name = "bfd-" + name + ".o",
            src = ":bfd-source[bfd/" + name + ".c]",
            headers = [
                ":bfd-source",
                ":zlib-source",
                libc_headers,
            ],
            object_name = "bfd{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":bfd-source",
                # do not sort
                includes = [
                    ":bfd-source[bfd]",
                    ":bfd-source[include]",
                    ":zlib-source[zlib]",
                ],
                logical_source = "bfd/" + name + ".c",
            )
        )
        for i, name in enumerate(BFD)
    ]

    c_library(
        name = "libbfd.a",
        objects = [":bfd-" + name + ".o" for name in BFD],
        output = "libbfd.a",
        toolchain = toolchain,
    )

    # libbfd reads and writes SFrame sections through libsframe.
    LIBSFRAME_ON = [
        "HAVE_BYTESWAP_H",
        "HAVE_DECL_BSWAP_16",
        "HAVE_DECL_BSWAP_32",
        "HAVE_DECL_BSWAP_64",
        "HAVE_DLFCN_H",
        "HAVE_ENDIAN_H",
        "HAVE_GETPAGESIZE",
        "HAVE_INTTYPES_H",
        "HAVE_MEMORY_H",
        "HAVE_MMAP",
        "HAVE_STDINT_H",
        "HAVE_STDLIB_H",
        "HAVE_STRINGS_H",
        "HAVE_STRING_H",
        "HAVE_SYS_PARAM_H",
        "HAVE_SYS_STAT_H",
        "HAVE_SYS_TYPES_H",
        "HAVE_UNISTD_H",
        "STDC_HEADERS",
    ]

    LIBSFRAME_VALUES = {
        "_GNU_SOURCE": "1",
        "PACKAGE": '"libsframe"',
        "PACKAGE_VERSION": '"2.41"',
        "VERSION": '"2.41"',
    }

    write_file(
        name = "libsframe-config.h",
        content = "\n".join(["#define " + name + " 1" for name in LIBSFRAME_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in LIBSFRAME_VALUES.items()]) + "\n",
    )

    filegroup(
        name = "libsframe-source",
        srcs = {path: ":binutils-2.41[" + path + "]" for path in LIBSFRAME_FILES + COMMON_HEADERS} | {
            "libsframe/config.h": ":libsframe-config.h",
        },
    )

    [
        c_object(
            name = "sframe-" + name + ".o",
            src = ":libsframe-source[libsframe/" + name + ".c]",
            defines = ["HAVE_CONFIG_H=1"],
            headers = [
                ":libsframe-source",
                libc_headers,
            ],
            object_name = "sframe{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":libsframe-source",
                # do not sort
                includes = [
                    ":libsframe-source[libsframe]",
                    ":libsframe-source[include]",
                    ":libsframe-source[libctf]",
                ],
                logical_source = "libsframe/" + name + ".c",
            )
        )
        for i, name in enumerate(LIBSFRAME)
    ]

    c_library(
        name = "libsframe.a",
        objects = [":sframe-" + name + ".o" for name in LIBSFRAME],
        output = "libsframe.a",
        toolchain = toolchain,
    )

    c_object(
        name = "bfd-test.o",
        src = "cellar//bootstrap/stage1/binutils241:tests/bfd.c",
        flags = cflags,
        headers = [
            ":bfd-source",
            libc_headers,
        ],
        # do not sort
        includes = [
            ":bfd-source[bfd]",
            ":bfd-source[include]",
        ],
        object_name = "bfdtest.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "bfd-test-bin",
        libraries = [
            ":libbfd.a",
            ":libsframe.a",
            ":libiberty.a",
            ":libz.a",
        ] + libc,
        objects = crt + [":bfd-test.o"] + crtn,
        output = "bfd-test",
        toolchain = toolchain,
    )

    command_test(
        name = "bfd-read-object-archive",
        args = [
            "$(location " + bfd_test_object + ")",
            "$(location :libiberty.a)",
        ],
        tool = ":bfd-test-bin",
    )

    generate(
        name = "bfd-write-output",
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        env = {"TMPDIR": "."} | action_env,
        files = ["passed"],
        tool = ":bfd-test-bin",
    )

    command_test(
        name = "bfd-write-object",
        args = [
            "$(location :bfd-write-output[passed])",
            "$(location :passed)",
        ],
        tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
    )

    OPCODES_ON = [
        "HAVE_DECL_STPCPY",
        "HAVE_DLFCN_H",
        "HAVE_INTTYPES_H",
        "HAVE_MEMORY_H",
        "HAVE_SIGSETJMP",
        "HAVE_STDINT_H",
        "HAVE_STDLIB_H",
        "HAVE_STRINGS_H",
        "HAVE_STRING_H",
        "HAVE_SYS_STAT_H",
        "HAVE_SYS_TYPES_H",
        "HAVE_UNISTD_H",
        "STDC_HEADERS",
        "ARCH_i386",
    ]

    OPCODES_VALUES = {
        "_GNU_SOURCE": "1",
        "HAVE_DECL_BASENAME": "0",
        "PACKAGE": '"opcodes"',
        "PACKAGE_VERSION": '"2.41"',
        "SIZEOF_VOID_P": "8",
        "VERSION": '"2.41"',
    }

    write_file(
        name = "opcodes-config.h",
        content = "\n".join(["#define " + name + " 1" for name in OPCODES_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in OPCODES_VALUES.items()]) + "\n",
    )

    # Preserve --srcdir as an input directory, and read the preprocessed opcode
    # table from it instead of standard input. Generated tables go to the
    # action's separate output directory instead of mutating the source tree.
    GEN_PATCHES = [
        "gen-input-dir",
        "gen-local-dir",
        "gen-no-chdir",
        "gen-opcodes-input",
        "gen-registers-path",
    ]

    [
        exact_patch(
            name = name,
            src = (":binutils-2.41[opcodes/i386-gen.c]" if i == 0 else ":" + GEN_PATCHES[i - 1]),
            patch = _patch(name),
        )
        for i, name in enumerate(GEN_PATCHES)
    ]

    filegroup(
        name = "opcodes-bootstrap-source",
        srcs = {path: ":binutils-2.41[" + path + "]" for path in OPCODES_FILES + COMMON_HEADERS + ["include/opcode/i386.h"]} | {
            "opcodes/config.h": ":opcodes-config.h",
            "opcodes/i386-gen.c": ":" + GEN_PATCHES[-1],
        },
    )

    c_object(
        name = "i386-gen.o",
        src = ":opcodes-bootstrap-source[opcodes/i386-gen.c]",
        headers = [
            ":opcodes-bootstrap-source",
            libc_headers,
        ],
        object_name = "i386gen.o",
        toolchain = toolchain,
        **source_attrs(
            tree = ":opcodes-bootstrap-source",
            # do not sort
            includes = [
                ":opcodes-bootstrap-source[opcodes]",
                ":opcodes-bootstrap-source[include]",
            ],
            logical_source = "opcodes/i386-gen.c",
            # do not sort
            logical_includes = [
                "opcodes",
                "include",
            ],
        )
    )

    c_binary(
        name = "i386-gen",
        libraries = [":libiberty.a"] + libc,
        objects = crt + [":i386-gen.o"] + crtn,
        output = "i386-gen",
        toolchain = toolchain,
    )

    # i386-gen reads the C-preprocessed opcode table. It ignores line markers,
    # so the preprocessor's paths do not reach the generated tables.
    generate(
        name = "i386-opc.i",
        args = [
            "-E",
            "-x",
            "c",
            "-DHAVE_CONFIG_H",
            "-I$(location :opcodes-bootstrap-source[opcodes])",
            "-I$(location :opcodes-bootstrap-source[include])",
            "$(location :opcodes-bootstrap-source[opcodes/i386-opc.tbl])",
        ],
        capture = "cellar//bootstrap/stage1/tools:capture",
        inputs = [":opcodes-bootstrap-source"],
        output = "i386-opc.i",
        tool = preprocessor,
    )

    filegroup(
        name = "i386-gen-input",
        srcs = {
            "i386-opc.i": ":i386-opc.i",
            "i386-reg.tbl": ":binutils-2.41[opcodes/i386-reg.tbl]",
        },
    )

    generate(
        name = "i386-tables",
        args = [
            "--srcdir",
            "$(location :i386-gen-input)",
        ],
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        files = I386_TABLES,
        tool = ":i386-gen",
    )

    [
        command_test(
            name = name + "-regeneration",
            args = [
                "$(location :i386-tables[" + name + "])",
                "$(location :binutils-2.41[opcodes/" + name + "])",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        )
        for name in I386_TABLES
    ]

    filegroup(
        name = "opcodes-source",
        srcs = {path: ":opcodes-bootstrap-source[" + path + "]" for path in OPCODES_FILES + COMMON_HEADERS + ["include/opcode/i386.h"]} | {"opcodes/config.h": ":opcodes-config.h"} | {"opcodes/" + name: ":i386-tables[" + name + "]" for name in I386_TABLES},
    )

    [
        c_object(
            name = "opcode-" + name + ".o",
            src = ":opcodes-source[opcodes/" + name + ".c]",
            headers = [
                ":opcodes-source",
                ":bfd-headers",
                libc_headers,
            ],
            object_name = "opc{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":opcodes-source",
                # do not sort
                includes = [
                    ":opcodes-source[opcodes]",
                    ":opcodes-source[include]",
                    ":bfd-headers[bfd]",
                ],
                logical_source = "opcodes/" + name + ".c",
                # do not sort
                logical_includes = [
                    "opcodes",
                    "include",
                ],
            )
        )
        for i, name in enumerate(OPCODES)
    ]

    c_library(
        name = "libopcodes.a",
        objects = [":opcode-" + name + ".o" for name in OPCODES],
        output = "libopcodes.a",
        toolchain = toolchain,
    )

    c_object(
        name = "opcodes-test.o",
        src = "cellar//bootstrap/stage1/binutils241:tests/opcodes.c",
        flags = cflags,
        headers = [
            ":opcodes-source",
            ":bfd-headers",
            libc_headers,
        ],
        # do not sort
        includes = [
            ":opcodes-source[opcodes]",
            ":opcodes-source[include]",
            ":bfd-headers[bfd]",
        ],
        object_name = "opctest.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "opcodes-test-bin",
        libraries = [
            ":libopcodes.a",
            ":libbfd.a",
            ":libsframe.a",
            ":libiberty.a",
            ":libz.a",
        ] + libc,
        objects = crt + [":opcodes-test.o"] + crtn,
        output = "opcodes-test",
        toolchain = toolchain,
    )

    command_test(
        name = "opcodes-disassembly",
        tool = ":opcodes-test-bin",
    )

    GAS_ON = [
        "HAVE_DLFCN_H",
        "HAVE_INTTYPES_H",
        "HAVE_LC_MESSAGES",
        "HAVE_MEMORY_H",
        "HAVE_STDINT_H",
        "HAVE_STDLIB_H",
        "HAVE_STRINGS_H",
        "HAVE_STRING_H",
        "HAVE_STRSIGNAL",
        "HAVE_ST_MTIM_TV_NSEC",
        "HAVE_ST_MTIM_TV_SEC",
        "HAVE_SYS_STAT_H",
        "HAVE_SYS_TYPES_H",
        "HAVE_TM_GMTOFF",
        "HAVE_UNISTD_H",
        "STDC_HEADERS",
        "HAVE_DECL_ASPRINTF",
        "HAVE_DECL_GETOPT",
        "HAVE_DECL_MEMPCPY",
        "HAVE_DECL_STPCPY",
        "DEFAULT_FLAG_COMPRESS_DEBUG",
    ]

    GAS_VALUES = {
        "_GNU_SOURCE": "1",
        "DEFAULT_ARCH": '"x86_64"',
        "DEFAULT_COMPRESSED_DEBUG_ALGORITHM": "COMPRESS_DEBUG_GABI_ZLIB",
        "DEFAULT_GENERATE_BUILD_NOTES": "0",
        "DEFAULT_GENERATE_ELF_STT_COMMON": "0",
        "DEFAULT_GENERATE_X86_RELAX_RELOCATIONS": "1",
        "DEFAULT_X86_USED_NOTE": "1",
        "PACKAGE": '"gas"',
        "PACKAGE_VERSION": '"2.41"',
        "VERSION": '"2.41"',
        "TARGET_ALIAS": '"x86_64-linux-musl"',
        "TARGET_CANONICAL": '"x86_64-unknown-linux-musl"',
        "TARGET_CPU": '"x86_64"',
        "TARGET_OS": '"linux-musl"',
        "TARGET_VENDOR": '"unknown"',
        "TARGET_BYTES_BIG_ENDIAN": "0",
        "LOCALEDIR": '"/nonexistent-bootstrap-binutils/locale"',
    }

    write_file(
        name = "gas-config.h",
        content = "\n".join(["#define " + name + " 1" for name in GAS_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in GAS_VALUES.items()]) + "\n",
    )

    # The original flonum constants describe a missing historical bc script. Build
    # all 26 powers directly with bounded base-65536 integer arithmetic instead.
    c_object(
        name = "flonum-gen.o",
        src = "cellar//bootstrap/stage1/binutils:generators/flonum.c",
        flags = cflags,
        headers = [libc_headers],
        object_name = "flonum.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "flonum-gen",
        libraries = libc,
        objects = crt + [":flonum-gen.o"] + crtn,
        output = "flonum-gen",
        toolchain = toolchain,
    )

    generate(
        name = "flonum-konst.c",
        capture = "cellar//bootstrap/stage1/tools:capture",
        tool = ":flonum-gen",
    )

    filegroup(
        name = "gas-source",
        srcs = {path: ":binutils-2.41[" + path + "]" for path in GAS_FILES} | {
            "gas/config.h": ":gas-config.h",
            "gas/targ-cpu.h": ":binutils-2.41[gas/config/tc-i386.h]",
            "gas/obj-format.h": ":binutils-2.41[gas/config/obj-elf.h]",
            "gas/targ-env.h": ":binutils-2.41[gas/config/te-linux.h]",
            "gas/flonum-konst.c": ":flonum-konst.c",
        },
    )

    [
        c_object(
            name = "gas-" + name.replace("/", "-") + ".o",
            src = ":gas-source[gas/" + name + ".c]",
            headers = [
                ":gas-source",
                ":bfd-source",
                ":opcodes-source",
                ":zlib-source",
                libc_headers,
            ],
            object_name = "gas{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":gas-source",
                # do not sort
                includes = [
                    ":gas-source[gas]",
                    ":gas-source[gas/config]",
                    ":bfd-source[bfd]",
                    ":bfd-source[include]",
                    ":bfd-source",
                    ":opcodes-source",
                    ":zlib-source[zlib]",
                ],
                logical_source = "gas/" + name + ".c",
                # do not sort
                logical_includes = [
                    "gas",
                    "gas/config",
                ],
            )
        )
        for i, name in enumerate(GAS)
    ]

    # GNU as 2.41 compiles the x86 tables into tc-i386 and links no libopcodes.
    c_binary(
        name = "as",
        libraries = [
            ":libbfd.a",
            ":libsframe.a",
            ":libiberty.a",
            ":libz.a",
        ] + libc,
        objects = crt + [":gas-" + name.replace("/", "-") + ".o" for name in GAS] + crtn,
        output = "as",
        toolchain = toolchain,
    )

    command_test(
        name = "as-version",
        args = ["--version"],
        tool = ":as",
    )

    generate(
        name = "as-fixture",
        args = [
            "--64",
            "$(location cellar//bootstrap/stage1/binutils:tests/native.s)",
            "-o",
        ],
        output = "native.o",
        tool = ":as",
    )

    bootstrap_artifact(
        name = "as-fixture.o",
        src = ":as-fixture",
        abi = "x86_64-sysv",
        archive_format = "ar",
        kind = "object",
        object_format = "elf64-x86-64",
    )

    c_object(
        name = "as-test.o",
        src = "cellar//bootstrap/stage1/binutils:tests/assembler.c",
        flags = cflags,
        headers = [libc_headers],
        object_name = "astest.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "as-test-bin",
        libraries = libc,
        objects = crt + [
            ":as-test.o",
            ":as-fixture.o",
        ] + crtn,
        output = "as-test",
        toolchain = toolchain,
    )

    command_test(
        name = "as-native-code-data",
        tool = ":as-test-bin",
    )

    command_test(
        name = "as-object-format",
        args = [
            "$(location :as-fixture)",
            "$(location :libiberty.a)",
        ],
        tool = ":bfd-test-bin",
    )

    command_test(
        name = "as-diagnostics",
        args = [
            "1",
            "$(exe :as)",
            "--64",
            "$(location cellar//bootstrap/stage1/binutils:tests/invalid.s)",
            "-o",
            "/dev/null",
        ],
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    )

    # Native ELF linker. Grammar, scanner, emulation and scripts are regenerated
    # independently; none of the release-generated C parsers is an input.
    [
        exact_patch(
            name = name,
            src = ":binutils-2.41[" + path + "]",
            patch = _patch(name),
        )
        for name, path in [
            ("ld-stringify", "ld/emultempl/elf.em"),
            ("ld-template-lines", "ld/genscrba.sh"),
        ]
    ]

    filegroup(
        name = "ld-generator-source",
        srcs = {path[3:]: ":binutils-2.41[" + path + "]" for path in LD_GENERATOR_INPUTS} | {
            "emultempl/elf.em": ":ld-stringify",
            "genscrba.sh": ":ld-template-lines",
        },
    )

    filegroup(
        name = "ld-generator-tools",
        srcs = {
            "cat": tools["cat"],
            "cmp": tools["cmp"],
            "mkdir": tools["mkdir"],
            "rm": tools["rm"],
            "sed": tools["sed"],
        },
    )

    LD_SCRIPTS = ["elf_x86_64." + suffix for suffix in [
        "xr",
        "xu",
        "x",
        "xe",
        "xn",
        "xbn",
        "xc",
        "xce",
        "xw",
        "xwe",
        "xs",
        "xse",
        "xsc",
        "xsce",
        "xsw",
        "xswe",
        "xd",
        "xde",
        "xdc",
        "xdce",
        "xdw",
        "xdwe",
    ]]

    generate(
        name = "ld-emulation",
        args = [
            "$(location :ld-generator-source[genscripts.sh])",
            "$(location :ld-generator-source)",
            "/nonexistent-bootstrap-binutils/lib",
            "/nonexistent-bootstrap-binutils",
            "/nonexistent-bootstrap-binutils",
            "x86_64-unknown-linux-musl",
            "x86_64-unknown-linux-musl",
            "x86_64-linux-musl",
            # No dependency directory, and no default library search path.
            "",
            ":",
            "elf_x86_64",
            "",
            "yes",
            "yes",
            "elf_x86_64",
        ],
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        env = {
            "PATH": "$(location :ld-generator-tools)",
            "TMPDIR": ".",
        } | action_env,
        files = ["eelf_x86_64.c"] + ["ldscripts/" + name for name in LD_SCRIPTS],
        inputs = [":ld-generator-source"],
        tool = tools["bash"],
    )

    generate(
        name = "ld-parser",
        args = [
            "--no-lines",
            "-d",
            "-o",
            "ldgram.c",
            "$(location :binutils-2.41[ld/ldgram.y])",
        ],
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        env = {"TMPDIR": "."} | action_env,
        files = [
            "ldgram.c",
            "ldgram.h",
        ],
        tool = tools["bison"],
    )

    generate(
        name = "ld-scanner",
        args = [
            "-L",
            "-t",
            "$(location :binutils-2.41[ld/ldlex.l])",
        ],
        capture = "cellar//bootstrap/stage1/tools:capture",
        tool = tools["flex"],
    )

    LD_ON = [
        "HAVE_CLOSE",
        "HAVE_DECL_ASPRINTF",
        "HAVE_DECL_ENVIRON",
        "HAVE_DECL_GETOPT",
        "HAVE_FCNTL_H",
        "HAVE_GETPAGESIZE",
        "HAVE_GLOB",
        "HAVE_INITFINI_ARRAY",
        "HAVE_INTTYPES_H",
        "HAVE_LC_MESSAGES",
        "HAVE_LIMITS_H",
        "HAVE_LSEEK",
        "HAVE_MEMORY_H",
        "HAVE_MKSTEMP",
        "HAVE_MMAP",
        "HAVE_OPEN",
        "HAVE_REALPATH",
        "HAVE_STDINT_H",
        "HAVE_STDLIB_H",
        "HAVE_STRINGS_H",
        "HAVE_STRING_H",
        "HAVE_SYS_FILE_H",
        "HAVE_SYS_MMAN_H",
        "HAVE_SYS_PARAM_H",
        "HAVE_SYS_STAT_H",
        "HAVE_SYS_TIME_H",
        "HAVE_SYS_TYPES_H",
        "HAVE_UNISTD_H",
        "HAVE_WAITPID",
        "STDC_HEADERS",
        "YYTEXT_POINTER",
        # Compress debug sections by default, as the assembler does. This is
        # configure's --enable-compressed-debug-sections=ld.
        "DEFAULT_FLAG_COMPRESS_DEBUG",
    ]

    # configure's x86_64 Linux defaults.
    LD_VALUES = {
        "_GNU_SOURCE": "1",
        "ELF_LIST_OPTIONS": "1",
        "ELF_SHLIB_LIST_OPTIONS": "1",
        "ELF_PLT_UNWIND_LIST_OPTIONS": "1",
        "DEFAULT_COMPRESSED_DEBUG_ALGORITHM": "COMPRESS_DEBUG_GABI_ZLIB",
        "DEFAULT_EMIT_GNU_HASH": "1",
        "DEFAULT_EMIT_SYSV_HASH": "1",
        "DEFAULT_LD_EXECSTACK": "1",
        "DEFAULT_LD_TEXTREL_CHECK": "textrel_check_warning",
        "DEFAULT_LD_TEXTREL_CHECK_WARNING": "1",
        "DEFAULT_LD_WARN_EXECSTACK": "2",
        "DEFAULT_LD_WARN_RWX_SEGMENTS": "1",
        "DEFAULT_LD_Z_RELRO": "1",
        "DEFAULT_LD_Z_SEPARATE_CODE": "1",
        "DEFAULT_NEW_DTAGS": "0",
        "GOT_HANDLING_DEFAULT": "GOT_HANDLING_TARGET_DEFAULT",
        "SUPPORT_ERROR_HANDLING_SCRIPT": "1",
        "SIZEOF_VOID_P": "8",
        "PACKAGE": '\"ld\"',
        "PACKAGE_VERSION": '\"2.41\"',
        "VERSION": '\"2.41\"',
        "DEFAULT_EMULATION": '\"elf_x86_64\"',
        "TARGET": '\"x86_64-unknown-linux-musl\"',
        "TARGET_SYSTEM_ROOT": '\"/nonexistent-bootstrap-sysroot\"',
        "BINDIR": '\"/nonexistent-bootstrap-binutils/bin\"',
        "TOOLBINDIR": '\"/nonexistent-bootstrap-binutils/bin\"',
        "SCRIPTDIR": '\"/nonexistent-bootstrap-binutils/lib\"',
        "LOCALEDIR": '\"/nonexistent-bootstrap-binutils/locale\"',
    }

    write_file(
        name = "ld-config.h",
        content = "\n".join(["#define " + name + " 1" for name in LD_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in LD_VALUES.items()]) + "\n",
    )

    write_file(
        name = "ldemul-list.h",
        content = "extern ld_emulation_xfer_type ld_elf_x86_64_emulation;\n#define EMULATION_LIST &ld_elf_x86_64_emulation, 0\n",
    )

    filegroup(
        name = "ld-source",
        srcs = {path[3:]: ":binutils-2.41[" + path + "]" for path in LD_FILES if path not in LD_GENERATOR_INPUTS} | {
            "config.h": ":ld-config.h",
            "ldgram.c": ":ld-parser[ldgram.c]",
            "ldgram.h": ":ld-parser[ldgram.h]",
            "ldlex.c": ":ld-scanner",
            "ldemul-list.h": ":ldemul-list.h",
            "eelf_x86_64.c": ":ld-emulation[eelf_x86_64.c]",
        },
    )

    [
        c_object(
            name = "ld-" + name + ".o",
            src = ":ld-source[" + name + ".c]",
            headers = [
                ":ld-source",
                ":bfd-source",
                ":zlib-source",
                libc_headers,
            ],
            object_name = "ld{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":ld-source",
                # do not sort
                includes = [
                    ":ld-source",
                    ":bfd-source[bfd]",
                    ":bfd-source[include]",
                    ":zlib-source[zlib]",
                ],
                logical_source = name + ".c",
                # do not sort
                logical_includes = ["."],
            )
        )
        for i, name in enumerate(LD)
    ]

    c_binary(
        name = "ld",
        libraries = [
            ":libbfd.a",
            ":libsframe.a",
            ":libiberty.a",
            ":libz.a",
        ] + libc,
        objects = crt + [":ld-" + name + ".o" for name in LD] + crtn,
        output = "ld",
        toolchain = toolchain,
    )

    command_test(
        name = "ld-version",
        args = ["--version"],
        tool = ":ld",
    )

    c_library(
        name = "ld-fixture.a",
        objects = [":as-fixture.o"],
        output = "native.a",
        toolchain = toolchain,
    )

    # GNU ld owns these link actions; the predecessor TCC supplies the input objects.
    generate(
        name = "ld-partial",
        args = [
            "-r",
            "$(location :as-test.o)",
            "$(location :as-fixture.o)",
            "-o",
        ],
        output = "partial.o",
        tool = ":ld",
    )

    [
        generate(
            name = "ld-" + name,
            args = [
                "-static",
                "--build-id=sha1",
            ] + ["$(location " + obj + ")" for obj in crt + objects + crtn + libc] + ["-o"],
            output = name,
            tool = ":ld",
        )
        for name, objects in [
            (
                "direct",
                [
                    ":as-test.o",
                    ":as-fixture.o",
                ],
            ),
            (
                "archive",
                [
                    ":as-test.o",
                    ":ld-fixture.a",
                ],
            ),
            (
                "partial-final",
                [":ld-partial"],
            ),
        ]
    ]

    [
        command_test(
            name = "ld-" + name + "-execution",
            args = [
                "0",
                "$(location :ld-" + name + ")",
            ],
            tool = "cellar//bootstrap/stage1/tools:expect-exit",
        )
        for name in [
            "direct",
            "archive",
            "partial-final",
        ]
    ]

    generate(
        name = "ld-script-object",
        args = [
            "--64",
            "$(location cellar//bootstrap/stage1/binutils:tests/linker.s)",
            "-o",
        ],
        output = "script.o",
        tool = ":as",
    )

    generate(
        name = "ld-script-program",
        args = [
            "-static",
            "--gc-sections",
            "-T",
            "$(location cellar//bootstrap/stage1/binutils:tests/linker.ld)",
            "$(location :ld-script-object)",
            "-o",
        ],
        output = "script-test",
        tool = ":ld",
    )

    command_test(
        name = "ld-script-execution",
        args = [
            "0",
            "$(location :ld-script-program)",
        ],
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    )

    [
        command_test(
            name = "ld-" + name,
            args = [
                "1",
                "$(exe :ld)",
            ] + args + [
                "-o",
                "/dev/null",
            ],
            tool = "cellar//bootstrap/stage1/tools:expect-exit",
        )
        for name, args in [
            (
                "missing-library",
                [
                    "-static",
                    "$(location :as-test.o)",
                    "-lc",
                ],
            ),
            (
                "unresolved-symbol",
                [
                    "-static",
                    "$(location :as-fixture.o)",
                ],
            ),
            (
                "invalid-script",
                [
                    "-T",
                    "$(location cellar//bootstrap/stage1/binutils:tests/invalid.ld)",
                    "$(location :ld-script-object)",
                ],
            ),
        ]
    ]

    # Complete native binutils command set, sharing normal upstream translation units.
    BINUTILS_ON = [
        "HAVE_DECL_ASPRINTF",
        "HAVE_DECL_ENVIRON",
        "HAVE_DECL_GETC_UNLOCKED",
        "HAVE_DECL_GETOPT",
        "HAVE_DECL_STPCPY",
        "HAVE_DECL_STRNLEN",
        "HAVE_FCNTL_H",
        "HAVE_FSEEKO",
        "HAVE_GETC_UNLOCKED",
        "HAVE_GETPAGESIZE",
        "HAVE_GOOD_UTIME_H",
        "HAVE_ICONV",
        "HAVE_INTTYPES_H",
        "HAVE_LC_MESSAGES",
        "HAVE_MBSTATE_T",
        "HAVE_MEMORY_H",
        "HAVE_MKDTEMP",
        "HAVE_MKSTEMP",
        "HAVE_MMAP",
        "HAVE_STDINT_H",
        "HAVE_STDLIB_H",
        "HAVE_STRINGS_H",
        "HAVE_STRING_H",
        "HAVE_STRUCT_STAT_ST_ATIM_TV_NSEC",
        "HAVE_SYS_FILE_H",
        "HAVE_SYS_PARAM_H",
        "HAVE_SYS_STAT_H",
        "HAVE_SYS_TIME_H",
        "HAVE_SYS_TYPES_H",
        "HAVE_SYS_WAIT_H",
        "HAVE_UNISTD_H",
        "HAVE_UTIMENSAT",
        "HAVE_UTIMES",
        "STDC_HEADERS",
        "TYPEOF_STRUCT_STAT_ST_ATIM_IS_STRUCT_TIMESPEC",
        "YYTEXT_POINTER",
    ]

    # Deterministic archives by default. Separate debug files are looked up
    # only below a nonexistent directory.
    BINUTILS_VALUES = {
        "_GNU_SOURCE": "1",
        "DEFAULT_AR_DETERMINISTIC": "1",
        "DEFAULT_STRINGS_ALL": "1",
        "DEFAULT_F_FOR_IFUNC_SYMBOLS": "0",
        "DEFAULT_FOR_FOLLOW_LINKS": "1",
        "DEFAULT_FOR_COLORED_DISASSEMBLY": "0",
        "DEBUGDIR": '\"/nonexistent-bootstrap-binutils/debug\"',
        "EXECUTABLE_SUFFIX": '\"\"',
        "TARGET_PREPENDS_UNDERSCORE": "0",
        "ICONV_CONST": "",
        "OBJDUMP_PRIVATE_VECTORS": "",
        "bin_dummy_emulation": "bin_vanilla_emulation",
        "PACKAGE": '\"binutils\"',
        "PACKAGE_VERSION": '\"2.41\"',
        "VERSION": '\"2.41\"',
        "TARGET": '\"x86_64-unknown-linux-musl\"',
        "LOCALEDIR": '\"/nonexistent-bootstrap-binutils/locale\"',
    }

    write_file(
        name = "binutils-config.h",
        content = "\n".join(["#define " + name + " 1" for name in BINUTILS_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in BINUTILS_VALUES.items()]) + "\n",
    )

    generate(
        name = "ar-parser",
        args = [
            "--no-lines",
            "-d",
            "-o",
            "arparse.c",
            "$(location :binutils-2.41[binutils/arparse.y])",
        ],
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        env = {"TMPDIR": "."} | action_env,
        files = [
            "arparse.c",
            "arparse.h",
        ],
        tool = tools["bison"],
    )

    generate(
        name = "ar-scanner",
        args = [
            "-L",
            "-t",
            "$(location :binutils-2.41[binutils/arlex.l])",
        ],
        capture = "cellar//bootstrap/stage1/tools:capture",
        tool = tools["flex"],
    )

    filegroup(
        name = "binutils-source",
        srcs = {path: ":binutils-2.41[" + path + "]" for path in BINUTILS_FILES + BINUTILS_HEADERS} | {
            "binutils/config.h": ":binutils-config.h",
            "binutils/arparse.c": ":ar-parser[arparse.c]",
            "binutils/arparse.h": ":ar-parser[arparse.h]",
            "binutils/arlex.c": ":ar-scanner",
        },
    )

    [
        c_object(
            name = "bin-" + name + ".o",
            src = ":binutils-source[binutils/" + name + ".c]",
            headers = [
                ":binutils-source",
                ":bfd-source",
                ":zlib-source",
                libc_headers,
            ],
            object_name = "bu{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":binutils-source",
                # do not sort
                includes = [
                    ":binutils-source[binutils]",
                    ":bfd-source[bfd]",
                    ":binutils-source[include]",
                    ":bfd-source[include]",
                    ":zlib-source[zlib]",
                ],
                logical_source = "binutils/" + name + ".c",
            )
        )
        for i, name in enumerate(BINUTILS)
    ]

    [
        c_binary(
            name = name,
            libraries = ([":libopcodes.a"] if name == "objdump" else []) + ([] if name in [
                "readelf",
                "elfedit",
            ] else [":libbfd.a"]) + ([] if name == "elfedit" else [":libsframe.a"]) + [
                ":libiberty.a",
                ":libz.a",
            ] + libc,
            objects = crt + [":bin-" + source + ".o" for source in sources] + crtn,
            output = name,
            toolchain = toolchain,
        )
        for name, sources in BINUTILS_PROGRAMS.items()
    ]

    [
        command_test(
            name = name + "-version",
            args = ["--version"],
            tool = ":" + name,
        )
        for name in BINUTILS_PROGRAMS
    ]

    filegroup(
        name = "command-test-tools",
        srcs = {name: ":" + name for name in BINUTILS_PROGRAMS} | {
            "ld": ":ld",
            "bytecmp": "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        },
    )

    filegroup(
        name = "command-test-input",
        srcs = {"a_native_object_name_longer_than_fifteen.o": ":as-fixture"},
    )

    generate(
        name = "debug-fixture",
        args = [
            "--64",
            "--gdwarf-2",
            "$(location cellar//bootstrap/stage1/binutils:tests/debug.s)",
            "-o",
        ],
        output = "debug.o",
        tool = ":as",
    )

    write_file(
        name = "command-test-success",
        content = "ok\n",
    )

    [
        [
            generate(
                name = "command-test-" + name,
                args = [
                    "$(location cellar//bootstrap/stage1/binutils:tests/commands.sh)",
                    name,
                    "$(location :command-test-input[a_native_object_name_longer_than_fifteen.o])",
                    "$(location :ld-direct)",
                    "$(location :debug-fixture)",
                ],
                chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
                directory = True,
                env = {
                    "PATH": "$(location :command-test-tools)",
                    "TMPDIR": ".",
                    "LC_ALL": "C",
                } | action_env,
                files = ["result"],
                tool = tools["bash"],
            ),
            command_test(
                name = "commands-" + name,
                args = [
                    "$(location :command-test-success)",
                    "$(location :command-test-" + name + "[result])",
                ],
                tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
            ),
        ]
        for name in [
            "archive",
            "inspect",
            "debug",
            "transform",
            "diagnostics",
        ]
    ]

    # Gprof keeps the native x86 call decoder. Its three explanatory text blocks
    # are generated by the upstream AWK program, using the bootstrapped gawk.
    [
        exact_patch(
            name = name,
            src = source,
            patch = _patch(name),
        )
        for name, source in [
            ("gprof-native", ":binutils-2.41[gprof/corefile.c]"),
            ("gprof-bounds", ":binutils-2.41[gprof/i386.c]"),
            ("gprof-displacement", ":gprof-bounds"),
            ("gprof-next-call", ":gprof-displacement"),
        ]
    ]

    [
        generate(
            name = name + ".c",
            args = [
                "-f",
                "$(location :binutils-2.41[gprof/gen-c-prog.awk])",
                "FUNCTION=" + name[:-3] + "_blurb",
                "FILE=" + name + ".m",
                "$(location :binutils-2.41[gprof/" + name + ".m])",
            ],
            capture = "cellar//bootstrap/stage1/tools:capture",
            tool = tools["gawk"],
        )
        for name in GPROF_BLURBS
    ]

    write_file(
        name = "gconfig.h",
        content = '#define PACKAGE "gprof"\n#define PACKAGE_VERSION "2.41"\n#define HAVE_DECL_GETOPT 1\n#define HAVE_SETITIMER 1\n#define HAVE_SYS_TIME_H 1\n',
    )

    filegroup(
        name = "gprof-source",
        srcs = {path[6:]: ":binutils-2.41[" + path + "]" for path in GPROF_FILES} | {
            "gconfig.h": ":gconfig.h",
            "corefile.c": ":gprof-native",
            "i386.c": ":gprof-next-call",
        } | {name + ".c": ":" + name + ".c" for name in GPROF_BLURBS},
    )

    [
        c_object(
            name = "gprof-" + name + ".o",
            src = ":gprof-source[" + name + ".c]",
            defines = [
                "DEBUG=1",
                'LOCALEDIR="/nonexistent-bootstrap-binutils/locale"',
            ],
            headers = [
                ":gprof-source",
                ":bfd-source",
                libc_headers,
            ],
            object_name = "gp{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":gprof-source",
                # do not sort
                includes = [
                    ":gprof-source",
                    ":bfd-source[bfd]",
                    ":bfd-source[include]",
                ],
                logical_source = name + ".c",
                tree_flags = ["-Isource/."],
            )
        )
        for i, name in enumerate(GPROF + GPROF_BLURBS)
    ]

    c_binary(
        name = "gprof",
        libraries = [
            ":libbfd.a",
            ":libsframe.a",
            ":libiberty.a",
            ":libz.a",
        ] + libc,
        objects = crt + [":gprof-" + name + ".o" for name in GPROF + GPROF_BLURBS] + crtn,
        output = "gprof",
        toolchain = toolchain,
    )

    command_test(
        name = "gprof-version",
        args = ["--version"],
        tool = ":gprof",
    )

    c_object(
        name = "profile-data.o",
        src = "cellar//bootstrap/stage1/binutils:tests/profile-data.c",
        flags = cflags,
        headers = [
            ":bfd-source",
            libc_headers,
        ],
        # do not sort
        includes = [
            ":bfd-source[bfd]",
            ":bfd-source[include]",
        ],
        object_name = "profile.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "profile-data",
        libraries = [
            ":libbfd.a",
            ":libsframe.a",
            ":libiberty.a",
            ":libz.a",
        ] + libc,
        objects = crt + [":profile-data.o"] + crtn,
        output = "profile-data",
        toolchain = toolchain,
    )

    generate(
        name = "profile-object",
        args = [
            "--64",
            "$(location cellar//bootstrap/stage1/binutils:tests/profile.s)",
            "-o",
        ],
        output = "profile.o",
        tool = ":as",
    )

    generate(
        name = "profile-program",
        args = [
            "-static",
            "$(location :profile-object)",
            "-o",
        ],
        output = "profile-program",
        tool = ":ld",
    )

    [
        generate(
            name = "profile-" + name,
            args = [
                "$(location :profile-program)",
                value,
            ],
            output = "gmon.out",
            tool = ":profile-data",
        )
        for name, value in [
            ("recorded", "1"),
            ("unrecorded", "0"),
        ]
    ]

    [
        [
            generate(
                name = "gprof-test-" + name,
                args = [
                    "$(location cellar//bootstrap/stage1/binutils:tests/profile.sh)",
                    name,
                    "$(exe :gprof)",
                    "$(location :profile-program)",
                    "$(location :profile-" + ("unrecorded" if name == "backward-call" else "recorded") + ")",
                ],
                chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
                directory = True,
                env = {
                    "TMPDIR": ".",
                    "LC_ALL": "C",
                    "PATH": "/nonexistent-bootstrap-binutils",
                } | action_env,
                files = ["result"],
                tool = tools["bash"],
            ),
            command_test(
                name = "gprof-" + name,
                args = [
                    "$(location :command-test-success)",
                    "$(location :gprof-test-" + name + "[result])",
                ],
                tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
            ),
        ]
        for name in [
            "counts",
            "backward-call",
            "explanations",
            "diagnostics",
        ]
    ]

    NATIVE_TOOLS = list(BINUTILS_PROGRAMS) + [
        "as",
        "ld",
        "gprof",
    ]

    filegroup(
        name = "bin",
        srcs = {name: ":" + name for name in NATIVE_TOOLS},
    )

    filegroup(
        name = "installation",
        srcs = {"bin/" + name: ":" + name for name in NATIVE_TOOLS} | {
            "share/ldscripts/" + name: ":ld-emulation[ldscripts/" + name + "]"
            for name in LD_SCRIPTS
        } | {
            "share/licenses/binutils/" + name: ":binutils-2.41[" + name + "]"
            for name in [
                "COPYING",
                "COPYING3",
                "COPYING.LIB",
                "COPYING3.LIB",
            ]
        },
    )
