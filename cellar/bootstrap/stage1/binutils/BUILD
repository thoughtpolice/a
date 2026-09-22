# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "concatenate", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "bootstrap_artifact", "c_binary", "c_library", "c_object", "compiler")
load(":sources.bzl", "BINUTILS_HEADERS", "COMMON_HEADERS")

MUSL = "cellar//bootstrap/stage1/musl"

CRT = [
    MUSL + ":restored-crt1.o",
    MUSL + ":restored-crti.o",
]

CRTN = [MUSL + ":restored-crtn.o"]

LIBC = [
    MUSL + ":restored-libc.a",
    "cellar//bootstrap/stage1/tcc-musl:musl2-libtcc1.a",
    MUSL + ":restored-libc.a",
]

LIBIBERTY = [
    "regex",
    "cplus-dem",
    "cp-demangle",
    "md5",
    "sha1",
    "alloca",
    "argv",
    "choose-temp",
    "concat",
    "cp-demint",
    "crc32",
    "d-demangle",
    "dwarfnames",
    "dyn-string",
    "fdmatch",
    "fibheap",
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
    "bfd/init.c",
    "bfd/libbfd-in.h",
    "bfd/libbfd.c",
    "bfd/libcoff-in.h",
    "bfd/linker.c",
    "bfd/opncls.c",
    "bfd/reloc.c",
    "bfd/section.c",
    "bfd/simple.c",
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

BFD_HEADER_GROUPS = [
    (
        "bfd",
        [
            "bfd-in.h",
            "init.c",
            "opncls.c",
            "libbfd.c",
            "bfdio.c",
            "bfdwin.c",
            "section.c",
            "archures.c",
            "reloc.c",
            "syms.c",
            "bfd.c",
            "archive.c",
            "corefile.c",
            "targets.c",
            "format.c",
            "linker.c",
            "simple.c",
            "compress.c",
        ],
        False,
    ),
    (
        "libbfd",
        [
            "libbfd-in.h",
            "libbfd.c",
            "bfdio.c",
            "bfdwin.c",
            "cache.c",
            "reloc.c",
            "archures.c",
            "linker.c",
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
    "format",
    "hash",
    "init",
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
    "elf64",
    # Shared ELF/x86 code refers to these helpers even with only ELF64 selected.
    "elf32",
    "elf-vxworks",
    "elf",
    "elflink",
    "elf-attrs",
    "elf-strtab",
    "elf-properties",
    "elf-eh-frame",
    "dwarf1",
    "dwarf2",
]

BFD_SOURCE_HEADERS = [
    "include/coff/ecoff.h",
    "bfd/libecoff.h",
    "bfd/coff-bfd.h",
    "bfd/genlink.h",
    "bfd/plugin.h",
    "include/elf/dwarf.h",
    "include/coff/sym.h",
    "bfd/sysdep.h",
    "bfd/libaout.h",
    "bfd/elf-bfd.h",
    "bfd/elf-linux-core.h",
    "bfd/elfxx-x86.h",
    "bfd/elf-nacl.h",
    "bfd/elf-vxworks.h",
    "bfd/elfcode.h",
    "bfd/elfcore.h",
    "include/elf/common.h",
    "include/elf/external.h",
    "include/elf/internal.h",
    "include/elf/reloc-macros.h",
    "include/elf/i386.h",
    "include/elf/x86-64.h",
    "include/elf/vxworks.h",
    "include/aout/ar.h",
    "include/aout/ranlib.h",
    "include/aout/aout64.h",
    "include/aout/stab_gnu.h",
    "include/aout/stab.def",
    "include/coff/internal.h",
    "include/opcode/i386.h",
]

BFD_FILES = ["bfd/" + name + ".c" for name in BFD] + BFD_SOURCE_HEADERS

OPCODES = [
    "dis-buf",
    "disassemble",
    "dis-init",
    "i386-dis",
    "i386-opc",
]

OPCODES_FILES = [
    "opcodes/dis-buf.c",
    "opcodes/disassemble.c",
    "opcodes/dis-init.c",
    "opcodes/i386-dis.c",
    "opcodes/i386-opc.c",
    "opcodes/i386-gen.c",
    "opcodes/sysdep.h",
    "opcodes/disassemble.h",
    "opcodes/opintl.h",
    "opcodes/i386-opc.h",
    "opcodes/i386-dis-evex.h",
    "opcodes/i386-opc.tbl",
    "opcodes/i386-reg.tbl",
]

OPCODE_FIXTURES = [
    "opcodes/i386-init.h",
    "opcodes/i386-tbl.h",
]

GAS = [
    "app",
    "as",
    "atof-generic",
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
    "gas/compress-debug.h",
    "gas/dwarf2dbg.h",
    "gas/dw2gencfi.h",
    "gas/ecoff.h",
    "gas/emul-target.h",
    "gas/emul.h",
    "gas/expr.h",
    "gas/flonum.h",
    "gas/frags.h",
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
    "gas/struc-symbol.h",
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
]

LD_HEADERS = [
    "ld/ld.h",
    "ld/ldctor.h",
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
    "ld/emultempl/elf32.em",
    "ld/emultempl/elf-generic.em",
    "ld/scripttempl/elf.sc",
    "ld/scripttempl/DWARF.sc",
    "ld/emulparams/elf_x86_64.sh",
    "ld/emulparams/plt_unwind.sh",
    "ld/emulparams/extern_protected_data.sh",
    "ld/emulparams/dynamic_undefined_weak.sh",
    "ld/emulparams/reloc_overflow.sh",
    "ld/emulparams/call_nop.sh",
    "ld/emulparams/cet.sh",
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
        "ieee",
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
        "ieee",
        "rdcoff",
        "wrstabs",
        "bucomm",
        "version",
        "filemode",
    ],
    "nm": [
        "nm",
        "bucomm",
        "version",
        "filemode",
    ],
    "objdump": [
        "objdump",
        "dwarf",
        "prdbg",
        "rddbg",
        "debug",
        "stabs",
        "ieee",
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

BINUTILS = [
    "addr2line",
    "ar",
    "arlex",
    "arparse",
    "arsup",
    "binemul",
    "bucomm",
    "cxxfilt",
    "debug",
    "dwarf",
    "elfcomm",
    "elfedit",
    "emul_vanilla",
    "filemode",
    "ieee",
    "is-ranlib",
    "is-strip",
    "nm",
    "not-ranlib",
    "not-strip",
    "objcopy",
    "objdump",
    "prdbg",
    "rdcoff",
    "rddbg",
    "readelf",
    "rename",
    "size",
    "stabs",
    "strings",
    "unwind-ia64",
    "version",
    "wrstabs",
]

BINUTILS_FILES = [
    "binutils/addr2line.c",
    "binutils/ar.c",
    "binutils/arsup.c",
    "binutils/binemul.c",
    "binutils/bucomm.c",
    "binutils/cxxfilt.c",
    "binutils/debug.c",
    "binutils/dwarf.c",
    "binutils/elfcomm.c",
    "binutils/elfedit.c",
    "binutils/emul_vanilla.c",
    "binutils/filemode.c",
    "binutils/ieee.c",
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

FILES = GPROF_FILES + BINUTILS_FILES + BINUTILS_HEADERS + LD_FILES + GAS_FILES + OPCODES_FILES + OPCODE_FIXTURES + LIBIBERTY_FILES + ZLIB_HEADERS + ["zlib/" + name + ".c" for name in ZLIB] + BFD_HEADER_INPUTS + HEADER_FIXTURES + [path for path in BFD_FILES if path not in BFD_HEADER_INPUTS]

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
    "HAVE_DECL_BASENAME",
]

LIBIBERTY_VALUES = {
    "SIZEOF_INT": "4",
    "SIZEOF_LONG": "8",
    "SIZEOF_LONG_LONG": "8",
    "SIZEOF_SIZE_T": "8",
    "STACK_DIRECTION": "-1",
    "UNSIGNED_64BIT_TYPE": "unsigned long",
    "PACKAGE": '"binutils"',
    "PACKAGE_VERSION": '"2.30"',
}

write_file(
    name = "libiberty-config.h",
    content = "#ifndef _GNU_SOURCE\n#define _GNU_SOURCE 1\n#endif\n" + "\n".join(["#define " + name + " 1" for name in LIBIBERTY_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in LIBIBERTY_VALUES.items()]) + "\n",
)

download_file(
    name = "binutils-2.30.tar.xz",
    hash = "6e46b8aeae2f727a36f0bd9505e405768a72218f1796f0d09757d45209871ae6",
    urls = ["https://mirrors.kernel.org/gnu/binutils/binutils-2.30.tar.xz"],
)

generate(
    name = "binutils.tar",
    args = [
        "--file",
        "$(location :binutils-2.30.tar.xz)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
)

untar(
    name = "binutils-2.30",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    input = ":binutils.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

[export_file(name = path) for path in glob([
    "patches/*.before",
    "patches/*.after",
    "tests/*.c",
    "tests/*.s",
    "tests/*.ld",
    "tests/*.sh",
    "generators/*.c",
])]

generate(
    name = "make-temp-file.c",
    args = [
        "$(location :binutils-2.30[libiberty/make-temp-file.c])",
        "$(location :patches/tmpdir.before)",
        "$(location :patches/tmpdir.after)",
    ],
    tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
)

# The upstream commented C generator is the source of the CRC table. Its
# published table is removed before the library consumes the prepared source.
[
    generate(
        name = name,
        args = flags + [
            script,
            "$(location :binutils-2.30[libiberty/crc32.c])",
        ],
        capture = "cellar//bootstrap/stage1/tools:capture",
        tool = "cellar//bootstrap/stage1/sed:sed",
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
    flags = ["-Werror"],
    headers = [MUSL + ":headers"],
    object_name = "crcgen.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "crcgen",
    libraries = LIBC,
    objects = CRT + [":crcgen.o"] + CRTN,
    output = "crcgen",
    toolchain = MUSL + ":tcc",
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
    srcs = {path: ":binutils-2.30[" + path + "]" for path in LIBIBERTY_FILES} | {
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
        flags = ["-Werror"],
        headers = [
            ":libiberty-source",
            MUSL + ":headers",
        ],
        # do not sort
        includes = [
            ":libiberty-source[libiberty]",
            ":libiberty-source[include]",
        ],
        object_name = "ib{}.o".format(i),
        toolchain = MUSL + ":tcc",
    )
    for i, name in enumerate(LIBIBERTY)
]

c_library(
    name = "libiberty.a",
    objects = [":iberty-" + name + ".o" for name in LIBIBERTY],
    output = "libiberty.a",
    toolchain = MUSL + ":tcc",
)

c_object(
    name = "libiberty-test.o",
    src = ":tests/libiberty.c",
    flags = ["-Werror"],
    headers = [
        ":libiberty-source",
        MUSL + ":headers",
    ],
    # do not sort
    includes = [
        ":libiberty-source[libiberty]",
        ":libiberty-source[include]",
    ],
    object_name = "test.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "libiberty-test-bin",
    libraries = [":libiberty.a"] + LIBC,
    objects = CRT + [":libiberty-test.o"] + CRTN,
    output = "libiberty-test",
    toolchain = MUSL + ":tcc",
)

command_test(
    name = "libiberty-test",
    tool = ":libiberty-test-bin",
)

command_test(
    name = "libiberty-missing-tmpdir",
    args = [
        "1",
        "$(location :libiberty-test-bin)",
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
    env = {"TMPDIR": "."},
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
    srcs = {path: ":binutils-2.30[" + path + "]" for path in ZLIB_HEADERS + ["zlib/" + name + ".c" for name in ZLIB]},
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
            flags = ["-Werror"],
            headers = [
                ":" + source,
                MUSL + ":headers",
            ],
            includes = [":" + source + "[zlib]"],
            object_name = "z{}.o".format(i),
            toolchain = MUSL + ":tcc",
        )
        for i, name in enumerate(ZLIB)
    ] + [
        c_library(
            name = stage + ".a",
            objects = [":" + stage + "-" + name + ".o" for name in ZLIB],
            output = "libz.a",
            toolchain = MUSL + ":tcc",
        ),
    ]
    for stage, source, extra in [
        (
            "zlib-bootstrap",
            "zlib-bootstrap-source",
            [
                "GEN_TREES_H=1",
                "MAKECRCH=1",
                "MAKEFIXED=1",
                "BUILDFIXED=1",
            ],
        ),
        ("libz", "zlib-source", []),
    ]
]

c_object(
    name = "zlib-tables.o",
    src = ":generators/zlib-tables.c",
    flags = ["-Werror"],
    headers = [
        ":zlib-bootstrap-source",
        MUSL + ":headers",
    ],
    includes = [":zlib-bootstrap-source[zlib]"],
    object_name = "ztables.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "zlib-tables",
    libraries = [":zlib-bootstrap.a"] + LIBC,
    objects = CRT + [":zlib-tables.o"] + CRTN,
    output = "zlib-tables",
    toolchain = MUSL + ":tcc",
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
        "crc32.h",
        "trees.h",
        "inffixed.h",
    ]
]

filegroup(
    name = "zlib-source",
    srcs = {path: ":binutils-2.30[" + path + "]" for path in ZLIB_HEADERS + ["zlib/" + name + ".c" for name in ZLIB]} | {"zlib/" + name: ":zlib-" + name + "[" + name + "]" for name in [
        "crc32.h",
        "trees.h",
        "inffixed.h",
    ]},
)

c_object(
    name = "zlib-test.o",
    src = ":tests/zlib.c",
    flags = ["-Werror"],
    headers = [
        ":zlib-source",
        MUSL + ":headers",
    ],
    includes = [":zlib-source[zlib]"],
    object_name = "ztest.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "zlib-test-bin",
    libraries = [":libz.a"] + LIBC,
    objects = CRT + [":zlib-test.o"] + CRTN,
    output = "zlib-test",
    toolchain = MUSL + ":tcc",
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
    "BFD_HOST_64BIT_LONG": "1",
    "BFD_HOST_64BIT_LONG_LONG": "1",
    "BFD_HOST_64_BIT_DEFINED": "1",
    "BFD_HOST_64_BIT": "long",
    "BFD_HOST_U_64_BIT": "unsigned long",
    "BFD_HOSTPTR_T": "unsigned long",
    "bfd_file_ptr": "long",
}

filegroup(
    name = "bfd-header-source",
    srcs = {path: ":binutils-2.30[" + path + "]" for path in BFD_HEADER_INPUTS + COMMON_HEADERS},
)

c_object(
    name = "chew.o",
    src = ":bfd-header-source[bfd/doc/chew.c]",
    flags = ["-Werror"],
    headers = [
        ":bfd-header-source",
        MUSL + ":headers",
    ],
    includes = [":bfd-header-source[include]"],
    object_name = "chew.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "chew",
    libraries = LIBC,
    objects = CRT + [":chew.o"] + CRTN,
    output = "chew",
    toolchain = MUSL + ":tcc",
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
            tool = "cellar//bootstrap/stage1/sed:sed",
        ),
        write_file(
            name = group + "-header-end",
            content = "#ifdef __cplusplus\n}\n#endif\n" + ("#endif\n" if group == "bfd" else ""),
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
                "$(location :binutils-2.30[bfd/" + ("bfd-in2" if group == "bfd" else group) + ".h])",
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
    tool = "cellar//bootstrap/stage1/sed:sed",
)

generate(
    name = "elf64-target.h",
    args = [
        "s/NN/64/g",
        "$(location :bfd-header-source[bfd/elfxx-target.h])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

generate(
    name = "targmatch.h",
    args = [
        "-f",
        "$(location :bfd-header-source[bfd/targmatch.sed])",
        "$(location :bfd-header-source[bfd/config.bfd])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

BFD_VERSION = {
    "bfd_version": "230000000",
    "bfd_version_string": '\"2.30\"',
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
    tool = "cellar//bootstrap/stage1/sed:sed",
)

write_file(
    name = "bfd_stdint.h",
    content = "#include <stdint.h>\n",
)

filegroup(
    name = "bfd-headers",
    srcs = {path: ":bfd-header-source[" + path + "]" for path in COMMON_HEADERS} | {"bfd/" + name: ":" + name for name in [
        "bfd.h",
        "bfdver.h",
        "bfd_stdint.h",
        "elf64-target.h",
        "targmatch.h",
    ]} | {
        "bfd/libbfd.h": ":libbfd-header-raw",
        "bfd/libcoff.h": ":libcoff-header-raw",
    },
)

c_object(
    name = "bfd-header-test.o",
    src = ":tests/bfd-headers.c",
    defines = ["PACKAGE_VERSION=\"2.30\""],
    flags = ["-Werror"],
    headers = [
        ":bfd-headers",
        MUSL + ":headers",
    ],
    includes = [
        ":bfd-headers[bfd]",
        ":bfd-headers[include]",
    ],
    object_name = "headers.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "bfd-header-test-bin",
    libraries = LIBC,
    objects = CRT + [":bfd-header-test.o"] + CRTN,
    output = "bfd-headers-test",
    toolchain = MUSL + ":tcc",
)

command_test(
    name = "bfd-native-headers",
    tool = ":bfd-header-test-bin",
)

BFD_ON = [
    "HAVE_ALLOCA_H",
    "HAVE_DIRENT_H",
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
    "HAVE_INTTYPES_H",
    "HAVE_LONG_DOUBLE",
    "HAVE_LONG_LONG",
    "HAVE_MADVISE",
    "HAVE_MEMORY_H",
    "HAVE_MMAP",
    "HAVE_MPROTECT",
    "HAVE_PRPSINFO_T",
    "HAVE_PRPSINFO_T_PR_PID",
    "HAVE_PRSTATUS_T",
    "HAVE_SETITIMER",
    "HAVE_STDDEF_H",
    "HAVE_STDINT_H",
    "HAVE_STDLIB_H",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_STRTOULL",
    "HAVE_SYSCONF",
    "HAVE_SYS_FILE_H",
    "HAVE_SYS_PROCFS_H",
    "HAVE_SYS_RESOURCE_H",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_TIME_H",
    "HAVE_SYS_TYPES_H",
    "HAVE_TIME_H",
    "HAVE_UNISTD_H",
    "HAVE_WCHAR_H",
    "HAVE_WCTYPE_H",
    "STDC_HEADERS",
    "STRING_WITH_STRINGS",
    "TIME_WITH_SYS_TIME",
    "USE_MMAP",
    "HAVE_DECL_ASPRINTF",
    "HAVE_DECL_BASENAME",
    "HAVE_DECL_FFS",
    "HAVE_DECL_FREE",
    "HAVE_DECL_FSEEKO",
    "HAVE_DECL_FTELLO",
    "HAVE_DECL_GETENV",
    "HAVE_DECL_MALLOC",
    "HAVE_DECL_REALLOC",
    "HAVE_DECL_SNPRINTF",
    "HAVE_DECL_STPCPY",
    "HAVE_DECL_STRNLEN",
    "HAVE_DECL_STRSTR",
    "HAVE_DECL_VASPRINTF",
    "HAVE_DECL_VSNPRINTF",
]

BFD_VALUES = {
    "_GNU_SOURCE": "1",
    "PACKAGE": '"bfd"',
    "PACKAGE_VERSION": '"2.30"',
    "VERSION": '"2.30"',
    "SIZEOF_CHAR": "1",
    "SIZEOF_SHORT": "2",
    "SIZEOF_INT": "4",
    "SIZEOF_LONG": "8",
    "SIZEOF_LONG_LONG": "8",
    "SIZEOF_OFF_T": "8",
    "SIZEOF_VOID_P": "8",
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
        "$(location :binutils-2.30[bfd/elf64-x86-64.c])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

filegroup(
    name = "bfd-source",
    srcs = {path: ":binutils-2.30[" + path + "]" for path in BFD_FILES + COMMON_HEADERS} | {"bfd/" + name: ":bfd-headers[bfd/" + name + "]" for name in [
        "bfd.h",
        "bfdver.h",
        "bfd_stdint.h",
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
        flags = ["-Werror"],
        headers = [
            ":bfd-source",
            ":zlib-source",
            MUSL + ":headers",
        ],
        # do not sort
        includes = [
            ":bfd-source[bfd]",
            ":bfd-source[include]",
            ":zlib-source[zlib]",
        ],
        object_name = "bfd{}.o".format(i),
        toolchain = MUSL + ":tcc",
    )
    for i, name in enumerate(BFD)
]

c_library(
    name = "libbfd.a",
    objects = [":bfd-" + name + ".o" for name in BFD],
    output = "libbfd.a",
    toolchain = MUSL + ":tcc",
)

c_object(
    name = "bfd-test.o",
    src = ":tests/bfd.c",
    flags = ["-Werror"],
    headers = [
        ":bfd-source",
        MUSL + ":headers",
    ],
    # do not sort
    includes = [
        ":bfd-source[bfd]",
        ":bfd-source[include]",
    ],
    object_name = "bfdtest.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "bfd-test-bin",
    libraries = [
        ":libbfd.a",
        ":libiberty.a",
        ":libz.a",
    ] + LIBC,
    objects = CRT + [":bfd-test.o"] + CRTN,
    output = "bfd-test",
    toolchain = MUSL + ":tcc",
)

command_test(
    name = "bfd-read-object-archive",
    args = [
        "$(location :crcgen.o)",
        "$(location :libiberty.a)",
    ],
    tool = ":bfd-test-bin",
)

generate(
    name = "bfd-write-output",
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
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
    "HAVE_DECL_BASENAME",
    "HAVE_DECL_STPCPY",
    "HAVE_INTTYPES_H",
    "HAVE_LIMITS_H",
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
    "STRING_WITH_STRINGS",
    "ARCH_i386",
]

OPCODES_VALUES = {
    "_GNU_SOURCE": "1",
    "PACKAGE": '"opcodes"',
    "PACKAGE_VERSION": '"2.30"',
    "VERSION": '"2.30"',
}

write_file(
    name = "opcodes-config.h",
    content = "\n".join(["#define " + name + " 1" for name in OPCODES_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in OPCODES_VALUES.items()]) + "\n",
)

# Preserve --srcdir as an input directory. Generated tables go to the action's
# separate output directory instead of mutating the source tree.
GEN_PATCHES = [
    "gen-input-dir",
    "gen-local-dir",
    "gen-no-chdir",
    "gen-opcodes-path",
    "gen-registers-path",
]

[
    generate(
        name = name,
        args = [
            "$(location " + (":binutils-2.30[opcodes/i386-gen.c]" if i == 0 else ":" + GEN_PATCHES[i - 1]) + ")",
            "$(location :patches/" + name + ".before)",
            "$(location :patches/" + name + ".after)",
        ],
        tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
    )
    for i, name in enumerate(GEN_PATCHES)
]

filegroup(
    name = "opcodes-bootstrap-source",
    srcs = {path: ":binutils-2.30[" + path + "]" for path in OPCODES_FILES + COMMON_HEADERS + ["include/opcode/i386.h"]} | {
        "opcodes/config.h": ":opcodes-config.h",
        "opcodes/i386-gen.c": ":" + GEN_PATCHES[-1],
    },
)

c_object(
    name = "i386-gen.o",
    src = ":opcodes-bootstrap-source[opcodes/i386-gen.c]",
    flags = ["-Werror"],
    headers = [
        ":opcodes-bootstrap-source",
        MUSL + ":headers",
    ],
    # do not sort
    includes = [
        ":opcodes-bootstrap-source[opcodes]",
        ":opcodes-bootstrap-source[include]",
    ],
    object_name = "i386gen.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "i386-gen",
    libraries = [":libiberty.a"] + LIBC,
    objects = CRT + [":i386-gen.o"] + CRTN,
    output = "i386-gen",
    toolchain = MUSL + ":tcc",
)

generate(
    name = "i386-tables",
    args = [
        "--srcdir",
        "$(location :opcodes-bootstrap-source[opcodes])",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    files = [
        "i386-init.h",
        "i386-tbl.h",
    ],
    tool = ":i386-gen",
)

[
    command_test(
        name = name + "-regeneration",
        args = [
            "$(location :i386-tables[" + name + "])",
            "$(location :binutils-2.30[opcodes/" + name + "])",
        ],
        tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
    )
    for name in [
        "i386-init.h",
        "i386-tbl.h",
    ]
]

filegroup(
    name = "opcodes-source",
    srcs = {path: ":opcodes-bootstrap-source[" + path + "]" for path in OPCODES_FILES + COMMON_HEADERS + ["include/opcode/i386.h"]} | {"opcodes/config.h": ":opcodes-config.h"} | {"opcodes/" + name: ":i386-tables[" + name + "]" for name in [
        "i386-init.h",
        "i386-tbl.h",
    ]},
)

[
    c_object(
        name = "opcode-" + name + ".o",
        src = ":opcodes-source[opcodes/" + name + ".c]",
        flags = ["-Werror"],
        headers = [
            ":opcodes-source",
            ":bfd-headers",
            MUSL + ":headers",
        ],
        # do not sort
        includes = [
            ":opcodes-source[opcodes]",
            ":opcodes-source[include]",
            ":bfd-headers[bfd]",
        ],
        object_name = "opc{}.o".format(i),
        toolchain = MUSL + ":tcc",
    )
    for i, name in enumerate(OPCODES)
]

c_library(
    name = "libopcodes.a",
    objects = [":opcode-" + name + ".o" for name in OPCODES],
    output = "libopcodes.a",
    toolchain = MUSL + ":tcc",
)

c_object(
    name = "opcodes-test.o",
    src = ":tests/opcodes.c",
    flags = ["-Werror"],
    headers = [
        ":opcodes-source",
        ":bfd-headers",
        MUSL + ":headers",
    ],
    # do not sort
    includes = [
        ":opcodes-source[opcodes]",
        ":opcodes-source[include]",
        ":bfd-headers[bfd]",
    ],
    object_name = "opctest.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "opcodes-test-bin",
    libraries = [
        ":libopcodes.a",
        ":libbfd.a",
        ":libiberty.a",
        ":libz.a",
    ] + LIBC,
    objects = CRT + [":opcodes-test.o"] + CRTN,
    output = "opcodes-test",
    toolchain = MUSL + ":tcc",
)

command_test(
    name = "opcodes-disassembly",
    tool = ":opcodes-test-bin",
)

GAS_ON = [
    "HAVE_ALLOCA",
    "HAVE_ALLOCA_H",
    "HAVE_ERRNO_H",
    "HAVE_INTTYPES_H",
    "HAVE_LC_MESSAGES",
    "HAVE_LIMITS_H",
    "HAVE_LOCALE_H",
    "HAVE_MEMORY_H",
    "HAVE_REMOVE",
    "HAVE_SBRK",
    "HAVE_SETLOCALE",
    "HAVE_STDINT_H",
    "HAVE_STDLIB_H",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_STRSIGNAL",
    "HAVE_ST_MTIM_TV_NSEC",
    "HAVE_ST_MTIM_TV_SEC",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_TYPES_H",
    "HAVE_TIME_H",
    "HAVE_TM_GMTOFF",
    "HAVE_UNISTD_H",
    "HAVE_UNLINK",
    "STDC_HEADERS",
    "STRING_WITH_STRINGS",
    "HAVE_DECL_ASPRINTF",
    "HAVE_DECL_FREE",
    "HAVE_DECL_GETENV",
    "HAVE_DECL_GETOPT",
    "HAVE_DECL_MALLOC",
    "HAVE_DECL_MEMPCPY",
    "HAVE_DECL_REALLOC",
    "HAVE_DECL_STPCPY",
    "HAVE_DECL_STRSTR",
    "HAVE_DECL_VSNPRINTF",
    "HAVE_DECL_BASENAME",
]

GAS_VALUES = {
    "_GNU_SOURCE": "1",
    "DEFAULT_ARCH": '"x86_64"',
    "DEFAULT_GENERATE_X86_RELAX_RELOCATIONS": "1",
    "DEFAULT_GENERATE_ELF_STT_COMMON": "0",
    # Compress debug sections by default. as.c and ldmain.c test this
    # with #ifdef, so any definition enables it.
    "DEFAULT_FLAG_COMPRESS_DEBUG": "1",
    "PACKAGE": '"gas"',
    "PACKAGE_VERSION": '"2.30"',
    "VERSION": '"2.30"',
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
    src = ":generators/flonum.c",
    flags = ["-Werror"],
    headers = [MUSL + ":headers"],
    object_name = "flonum.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "flonum-gen",
    libraries = LIBC,
    objects = CRT + [":flonum-gen.o"] + CRTN,
    output = "flonum-gen",
    toolchain = MUSL + ":tcc",
)

generate(
    name = "flonum-konst.c",
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = ":flonum-gen",
)

filegroup(
    name = "gas-source",
    srcs = {path: ":binutils-2.30[" + path + "]" for path in GAS_FILES} | {
        "gas/config.h": ":gas-config.h",
        "gas/targ-cpu.h": ":binutils-2.30[gas/config/tc-i386.h]",
        "gas/obj-format.h": ":binutils-2.30[gas/config/obj-elf.h]",
        "gas/targ-env.h": ":binutils-2.30[gas/config/te-linux.h]",
        "gas/flonum-konst.c": ":flonum-konst.c",
    },
)

[
    c_object(
        name = "gas-" + name.replace("/", "-") + ".o",
        src = ":gas-source[gas/" + name + ".c]",
        flags = ["-Werror"],
        headers = [
            ":gas-source",
            ":bfd-source",
            ":opcodes-source",
            ":zlib-source",
            MUSL + ":headers",
        ],
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
        object_name = "gas{}.o".format(i),
        toolchain = MUSL + ":tcc",
    )
    for i, name in enumerate(GAS)
]

c_binary(
    name = "as",
    libraries = [
        ":libopcodes.a",
        ":libbfd.a",
        ":libiberty.a",
        ":libz.a",
    ] + LIBC,
    objects = CRT + [":gas-" + name.replace("/", "-") + ".o" for name in GAS] + CRTN,
    output = "as",
    toolchain = MUSL + ":tcc",
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
        "$(location :tests/native.s)",
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
    src = ":tests/assembler.c",
    flags = ["-Werror"],
    headers = [MUSL + ":headers"],
    object_name = "astest.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "as-test-bin",
    libraries = LIBC,
    objects = CRT + [
        ":as-test.o",
        ":as-fixture.o",
    ] + CRTN,
    output = "as-test",
    toolchain = MUSL + ":tcc",
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
        "$(location :as)",
        "--64",
        "$(location :tests/invalid.s)",
        "-o",
        "/dev/null",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

# Native ELF linker. Grammar, scanner, emulation and scripts are regenerated
# independently; none of the release-generated C parsers is an input.
[
    generate(
        name = name,
        args = [
            "$(location :binutils-2.30[" + path + "])",
            "$(location :patches/" + name + ".before)",
            "$(location :patches/" + name + ".after)",
        ],
        tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
    )
    for name, path in [
        ("ld-stringify", "ld/emultempl/elf32.em"),
        ("ld-template-lines", "ld/genscrba.sh"),
    ]
]

filegroup(
    name = "ld-generator-source",
    srcs = {path[3:]: ":binutils-2.30[" + path + "]" for path in LD_GENERATOR_INPUTS} | {
        "emultempl/elf32.em": ":ld-stringify",
        "genscrba.sh": ":ld-template-lines",
    },
)

filegroup(
    name = "ld-generator-tools",
    srcs = {
        "cat": "cellar//bootstrap/stage1/coreutils:cat",
        "mkdir": "cellar//bootstrap/stage0-posix/mescc-tools-extra:mkdir",
        "rm": "cellar//bootstrap/stage1/coreutils:rm",
        "sed": "cellar//bootstrap/stage1/sed:sed",
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
        "elf_x86_64",
        "",
        "yes",
        "yes",
        "elf_x86_64",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {
        "LIB_PATH": ":",
        "PATH": "$(location :ld-generator-tools)",
        "TMPDIR": ".",
    },
    files = ["eelf_x86_64.c"] + ["ldscripts/" + name for name in LD_SCRIPTS],
    inputs = [":ld-generator-source"],
    tool = "cellar//bootstrap/stage1/bash-bootstrap:bash",
)

generate(
    name = "ld-parser",
    args = [
        "--no-lines",
        "-d",
        "-o",
        "ldgram.c",
        "$(location :binutils-2.30[ld/ldgram.y])",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = [
        "ldgram.c",
        "ldgram.h",
    ],
    tool = "cellar//bootstrap/stage1/bison:bison",
)

generate(
    name = "ld-scanner",
    args = [
        "-L",
        "-t",
        "$(location :binutils-2.30[ld/ldlex.l])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/flex:flex",
)

LD_ON = [
    "HAVE_CLOSE",
    "HAVE_DECL_ENVIRON",
    "HAVE_DECL_FREE",
    "HAVE_DECL_GETENV",
    "HAVE_DECL_GETOPT",
    "HAVE_DECL_SBRK",
    "HAVE_DECL_STRSTR",
    "HAVE_DIRENT_H",
    "HAVE_FCNTL_H",
    "HAVE_GETPAGESIZE",
    "HAVE_GLOB",
    "HAVE_INITFINI_ARRAY",
    "HAVE_INTTYPES_H",
    "HAVE_LC_MESSAGES",
    "HAVE_LIMITS_H",
    "HAVE_LOCALE_H",
    "HAVE_LSEEK",
    "HAVE_MEMORY_H",
    "HAVE_MKSTEMP",
    "HAVE_MMAP",
    "HAVE_OPEN",
    "HAVE_REALPATH",
    "HAVE_SBRK",
    "HAVE_SETLOCALE",
    "HAVE_STDINT_H",
    "HAVE_STDLIB_H",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_SYS_FILE_H",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_TIME_H",
    "HAVE_SYS_TYPES_H",
    "HAVE_UNISTD_H",
    "HAVE_WAITPID",
    "STDC_HEADERS",
    "STRING_WITH_STRINGS",
    "YYTEXT_POINTER",
]

LD_VALUES = {
    "_GNU_SOURCE": "1",
    "ELF_LIST_OPTIONS": "1",
    "ELF_SHLIB_LIST_OPTIONS": "1",
    "ELF_PLT_UNWIND_LIST_OPTIONS": "1",
    "DEFAULT_EMIT_GNU_HASH": "0",
    "DEFAULT_EMIT_SYSV_HASH": "1",
    # Compress debug sections by default. as.c and ldmain.c test this
    # with #ifdef, so any definition enables it.
    "DEFAULT_FLAG_COMPRESS_DEBUG": "1",
    "DEFAULT_LD_Z_RELRO": "0",
    "DEFAULT_NEW_DTAGS": "0",
    "GOT_HANDLING_DEFAULT": "GOT_HANDLING_TARGET_DEFAULT",
    "SIZEOF_VOID_P": "8",
    "PACKAGE": '\"ld\"',
    "PACKAGE_VERSION": '\"2.30\"',
    "VERSION": '\"2.30\"',
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
    srcs = {path[3:]: ":binutils-2.30[" + path + "]" for path in LD_FILES if path not in LD_GENERATOR_INPUTS} | {
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
        flags = ["-Werror"],
        headers = [
            ":ld-source",
            ":bfd-source",
            MUSL + ":headers",
        ],
        # do not sort
        includes = [
            ":ld-source",
            ":bfd-source[bfd]",
            ":bfd-source[include]",
        ],
        object_name = "ld{}.o".format(i),
        toolchain = MUSL + ":tcc",
    )
    for i, name in enumerate(LD)
]

c_binary(
    name = "ld",
    libraries = [
        ":libbfd.a",
        ":libiberty.a",
        ":libz.a",
    ] + LIBC,
    objects = CRT + [":ld-" + name + ".o" for name in LD] + CRTN,
    output = "ld",
    toolchain = MUSL + ":tcc",
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
    toolchain = MUSL + ":tcc",
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
        ] + ["$(location " + obj + ")" for obj in CRT + objects + CRTN + LIBC] + ["-o"],
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
        "$(location :tests/linker.s)",
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
        "$(location :tests/linker.ld)",
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
            "$(location :ld)",
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
                "$(location :tests/invalid.ld)",
                "$(location :ld-script-object)",
            ],
        ),
    ]
]

# Complete native binutils command set, sharing normal upstream translation units.
BINUTILS_ON = [
    "HAVE_ALLOCA",
    "HAVE_ALLOCA_H",
    "HAVE_DECL_ASPRINTF",
    "HAVE_DECL_ENVIRON",
    "HAVE_DECL_FPRINTF",
    "HAVE_DECL_GETC_UNLOCKED",
    "HAVE_DECL_GETENV",
    "HAVE_DECL_GETOPT",
    "HAVE_DECL_SBRK",
    "HAVE_DECL_SNPRINTF",
    "HAVE_DECL_STPCPY",
    "HAVE_DECL_STRNLEN",
    "HAVE_DECL_STRSTR",
    "HAVE_DECL_VSNPRINTF",
    "HAVE_FCNTL_H",
    "HAVE_GETC_UNLOCKED",
    "HAVE_GOOD_UTIME_H",
    "HAVE_ICONV",
    "HAVE_INTTYPES_H",
    "HAVE_LC_MESSAGES",
    "HAVE_LIMITS_H",
    "HAVE_LOCALE_H",
    "HAVE_LONG_LONG",
    "HAVE_MBSTATE_T",
    "HAVE_MEMORY_H",
    "HAVE_MKDTEMP",
    "HAVE_MKSTEMP",
    "HAVE_SBRK",
    "HAVE_SETLOCALE",
    "HAVE_STDINT_H",
    "HAVE_STDLIB_H",
    "HAVE_STRCOLL",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_SYS_FILE_H",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_TYPES_H",
    "HAVE_SYS_WAIT_H",
    "HAVE_TIME_T_IN_TIME_H",
    "HAVE_TIME_T_IN_TYPES_H",
    "HAVE_UNISTD_H",
    "HAVE_UTIMES",
    "HAVE_WCHAR_H",
    "STDC_HEADERS",
    "STRING_WITH_STRINGS",
    "YYTEXT_POINTER",
]

BINUTILS_VALUES = {
    "_GNU_SOURCE": "1",
    "DEFAULT_AR_DETERMINISTIC": "1",
    "DEFAULT_STRINGS_ALL": "1",
    "TARGET_PREPENDS_UNDERSCORE": "0",
    "SIZEOF_LONG": "8",
    "SIZEOF_LONG_LONG": "8",
    "ICONV_CONST": "",
    "OBJDUMP_PRIVATE_VECTORS": "",
    "bin_dummy_emulation": "bin_vanilla_emulation",
    "PACKAGE": '\"binutils\"',
    "PACKAGE_VERSION": '\"2.30\"',
    "VERSION": '\"2.30\"',
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
        "$(location :binutils-2.30[binutils/arparse.y])",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = [
        "arparse.c",
        "arparse.h",
    ],
    tool = "cellar//bootstrap/stage1/bison:bison",
)

generate(
    name = "ar-scanner",
    args = [
        "-L",
        "-t",
        "$(location :binutils-2.30[binutils/arlex.l])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/flex:flex",
)

filegroup(
    name = "binutils-source",
    srcs = {path: ":binutils-2.30[" + path + "]" for path in BINUTILS_FILES + BINUTILS_HEADERS} | {
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
        flags = ["-Werror"],
        headers = [
            ":binutils-source",
            ":bfd-source",
            ":zlib-source",
            MUSL + ":headers",
        ],
        # do not sort
        includes = [
            ":binutils-source[binutils]",
            ":bfd-source[bfd]",
            ":binutils-source[include]",
            ":bfd-source[include]",
            ":zlib-source[zlib]",
        ],
        object_name = "bu{}.o".format(i),
        toolchain = MUSL + ":tcc",
    )
    for i, name in enumerate(BINUTILS)
]

[
    c_binary(
        name = name,
        libraries = ([":libopcodes.a"] if name == "objdump" else []) + ([] if name in [
            "readelf",
            "elfedit",
        ] else [":libbfd.a"]) + [
            ":libiberty.a",
            ":libz.a",
        ] + LIBC,
        objects = CRT + [":bin-" + source + ".o" for source in sources] + CRTN,
        output = name,
        toolchain = MUSL + ":tcc",
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
        "$(location :tests/debug.s)",
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
                "$(location :tests/commands.sh)",
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
            },
            files = ["result"],
            tool = "cellar//bootstrap/stage1/bash-bootstrap:bash",
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
    generate(
        name = name,
        args = [
            "$(location " + source + ")",
            "$(location :patches/" + name + ".before)",
            "$(location :patches/" + name + ".after)",
        ],
        tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
    )
    for name, source in [
        ("gprof-native", ":binutils-2.30[gprof/corefile.c]"),
        ("gprof-bounds", ":binutils-2.30[gprof/i386.c]"),
        ("gprof-displacement", ":gprof-bounds"),
        ("gprof-next-call", ":gprof-displacement"),
    ]
]

[
    generate(
        name = name + ".c",
        args = [
            "-f",
            "$(location :binutils-2.30[gprof/gen-c-prog.awk])",
            "FUNCTION=" + name[:-3] + "_blurb",
            "FILE=" + name + ".m",
            "$(location :binutils-2.30[gprof/" + name + ".m])",
        ],
        capture = "cellar//bootstrap/stage1/tools:capture",
        tool = "cellar//bootstrap/stage1/gawk:gawk",
    )
    for name in GPROF_BLURBS
]

write_file(
    name = "gconfig.h",
    content = '#include <limits.h>\n#define PACKAGE "gprof"\n#define PACKAGE_VERSION "2.30"\n#define HAVE_DECL_GETOPT 1\n',
)

filegroup(
    name = "gprof-source",
    srcs = {path[6:]: ":binutils-2.30[" + path + "]" for path in GPROF_FILES} | {
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
        flags = ["-Werror"],
        headers = [
            ":gprof-source",
            ":bfd-source",
            MUSL + ":headers",
        ],
        # do not sort
        includes = [
            ":gprof-source",
            ":bfd-source[bfd]",
            ":bfd-source[include]",
        ],
        object_name = "gp{}.o".format(i),
        toolchain = MUSL + ":tcc",
    )
    for i, name in enumerate(GPROF + GPROF_BLURBS)
]

c_binary(
    name = "gprof",
    libraries = [
        ":libbfd.a",
        ":libiberty.a",
        ":libz.a",
    ] + LIBC,
    objects = CRT + [":gprof-" + name + ".o" for name in GPROF + GPROF_BLURBS] + CRTN,
    output = "gprof",
    toolchain = MUSL + ":tcc",
)

command_test(
    name = "gprof-version",
    args = ["--version"],
    tool = ":gprof",
)

c_object(
    name = "profile-data.o",
    src = ":tests/profile-data.c",
    flags = ["-Werror"],
    headers = [
        ":bfd-source",
        MUSL + ":headers",
    ],
    # do not sort
    includes = [
        ":bfd-source[bfd]",
        ":bfd-source[include]",
    ],
    object_name = "profile.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "profile-data",
    libraries = [
        ":libbfd.a",
        ":libiberty.a",
        ":libz.a",
    ] + LIBC,
    objects = CRT + [":profile-data.o"] + CRTN,
    output = "profile-data",
    toolchain = MUSL + ":tcc",
)

generate(
    name = "profile-object",
    args = [
        "--64",
        "$(location :tests/profile.s)",
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
                "$(location :tests/profile.sh)",
                name,
                "$(location :gprof)",
                "$(location :profile-program)",
                "$(location :profile-" + ("unrecorded" if name == "backward-call" else "recorded") + ")",
            ],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            env = {
                "TMPDIR": ".",
                "LC_ALL": "C",
                "PATH": "/nonexistent-bootstrap-binutils",
            },
            files = ["result"],
            tool = "cellar//bootstrap/stage1/bash-bootstrap:bash",
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
        "share/licenses/binutils/" + name: ":binutils-2.30[" + name + "]"
        for name in [
            "COPYING",
            "COPYING3",
            "COPYING.LIB",
            "COPYING3.LIB",
        ]
    },
)

# The compile, archive and link commands have distinct executable providers.
# This bridge is used by the last musl/TCC pass before GCC becomes available.
compiler(
    name = "tcc-with-binutils",
    abi = "x86_64-sysv",
    archive_flags = ["crsD"],
    archive_format = "ar",
    archiver = ":ar",
    cflags = ["-nostdinc"],
    compiler = "cellar//bootstrap/stage1/tcc-musl:tcc-musl2",
    execution_runtime = MUSL + ":runtime-rebuilt",
    family = "tcc",
    ldflags = ["-static"],
    linker = ":ld",
    object_format = "elf64-x86-64",
    stage = "musl-with-binutils",
    sysroot = MUSL + ":runtime-restored",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
)

c_library(
    name = "gnu-test.a",
    objects = [":as-fixture.o"],
    output = "native.a",
    toolchain = ":tcc-with-binutils",
)

c_binary(
    name = "gnu-toolchain-test-bin",
    libraries = [":gnu-test.a"] + LIBC,
    objects = CRT + [":as-test.o"] + CRTN,
    output = "gnu-toolchain-test",
    toolchain = ":tcc-with-binutils",
)

command_test(
    name = "gnu-toolchain-link",
    tool = ":gnu-toolchain-test-bin",
)
