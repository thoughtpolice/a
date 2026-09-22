# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Second GCC 4.0.4 build: predecessor GCC plus full musl 1.2.5.
# Shared handwritten patches/inventories remain in gcc40; each generator and
# compiler action below belongs to this new stage.

load("@cellar//bootstrap:actions.bzl", "command_test", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "bootstrap_artifact", "c_binary", "c_library", "c_object", "compiler", "sysroot")
load("@cellar//bootstrap/stage1/gcc40:sources.bzl", "GCC_HEADERS", "LIBRARY_HEADERS")

PREDECESSOR = "cellar//bootstrap/stage1/musl12:gcc"

MUSL = "cellar//bootstrap/stage1/musl12"

CRT = [
    MUSL + ":crt1.o",
    MUSL + ":crti.o",
    "cellar//bootstrap/stage1/gcc40:crtbeginT.o",
]

CRTN = [
    "cellar//bootstrap/stage1/gcc40:crtend.o",
    MUSL + ":crtn.o",
]

LIBC = [
    MUSL + ":libc.a",
    "cellar//bootstrap/stage1/gcc40:libgcc.a",
    MUSL + ":libc.a",
]

LIBIBERTY = [
    "regex",
    "cplus-dem",
    "cp-demangle",
    "md5",
    "alloca",
    "argv",
    "choose-temp",
    "concat",
    "cp-demint",
    "dyn-string",
    "fdmatch",
    "fibheap",
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
    "physmem",
    "safe-ctype",
    "sort",
    "spaces",
    "splay-tree",
    "strerror",
    "strsignal",
    "ternary",
    "xatexit",
    "xexit",
    "xmalloc",
    "xmemdup",
    "xstrdup",
    "xstrerror",
    "pex-unix",
]

LIBCPP = [
    "charset",
    "directives",
    "errors",
    "expr",
    "files",
    "identifiers",
    "init",
    "lex",
    "line-map",
    "macro",
    "mkdeps",
    "pch",
    "symtab",
    "traditional",
]

MACHINE_GENERATORS = [
    "gencheck",
    "gengenrtl",
    "genmodes",
    "genconstants",
    "genconditions",
    "genpreds",
    "genconfig",
    "genflags",
    "gencodes",
    "genemit",
    "genopinit",
    "genrecog",
    "genextract",
    "genpeep",
    "genattr",
    "genoutput",
    "genattrtab",
    "genautomata",
]

GENERATOR_SUPPORT = [
    "errors",
    "ggc-none",
    "rtl",
    "read-rtl",
    "gensupport",
    "dummy-conditions",
    "print-rtl",
    "varray",
]

GTFILES = [
    "gcc/input.h",
    "gcc/coretypes.h",
    "libcpp/include/line-map.h",
    "libcpp/include/cpplib.h",
    "libcpp/include/cpp-id-data.h",
    "gcc/config/i386/biarch64.h",
    "gcc/config/i386/i386.h",
    "gcc/config/i386/unix.h",
    "gcc/config/i386/att.h",
    "gcc/config/dbxelf.h",
    "gcc/config/elfos.h",
    "gcc/config/svr4.h",
    "gcc/config/linux.h",
    "gcc/config/i386/x86-64.h",
    "gcc/config/i386/linux64.h",
    "include/hashtab.h",
    "include/splay-tree.h",
    "gcc/bitmap.h",
    "gcc/coverage.c",
    "gcc/function.h",
    "gcc/rtl.h",
    "gcc/optabs.h",
    "gcc/tree.h",
    "gcc/libfuncs.h",
    "libcpp/include/symtab.h",
    "gcc/real.h",
    "gcc/varray.h",
    "gcc/insn-addr.h",
    "gcc/hwint.h",
    "gcc/cselib.h",
    "gcc/basic-block.h",
    "gcc/cgraph.h",
    "gcc/c-common.h",
    "gcc/c-tree.h",
    "gcc/reload.h",
    "gcc/alias.c",
    "gcc/bitmap.c",
    "gcc/cselib.c",
    "gcc/cgraph.c",
    "gcc/dbxout.c",
    "gcc/dwarf2out.c",
    "gcc/dwarf2asm.c",
    "gcc/dojump.c",
    "gcc/emit-rtl.c",
    "gcc/except.c",
    "gcc/explow.c",
    "gcc/expr.c",
    "gcc/function.c",
    "gcc/gcse.c",
    "gcc/integrate.c",
    "gcc/lists.c",
    "gcc/optabs.c",
    "gcc/profile.c",
    "gcc/regclass.c",
    "gcc/reg-stack.c",
    "gcc/cfglayout.c",
    "gcc/sdbout.c",
    "gcc/stor-layout.c",
    "gcc/stringpool.c",
    "gcc/tree.c",
    "gcc/varasm.c",
    "gcc/tree-mudflap.c",
    "gcc/tree-flow.h",
    "gcc/c-objc-common.c",
    "gcc/c-common.c",
    "gcc/c-parse.in",
    "gcc/tree-ssanames.c",
    "gcc/tree-eh.c",
    "gcc/tree-phinodes.c",
    "gcc/tree-cfg.c",
    "gcc/tree-dfa.c",
    "gcc/tree-ssa-propagate.c",
    "gcc/tree-iterator.c",
    "gcc/gimplify.c",
    "gcc/tree-chrec.h",
    "gcc/tree-complex.c",
    "gcc/tree-ssa-operands.h",
    "gcc/tree-ssa-operands.c",
    "gcc/tree-profile.c",
    "gcc/rtl-profile.c",
    "gcc/tree-nested.c",
    "gcc/config/i386/i386.c",
    "gcc/c-lang.c",
    "gcc/c-parse.in",
    "gcc/c-tree.h",
    "gcc/c-decl.c",
    "gcc/c-common.c",
    "gcc/c-common.h",
    "gcc/c-pragma.c",
    "gcc/c-objc-common.c",
]

GT_LANG_FILES = [
    "gcc/c-lang.c",
    "gcc/c-parse.in",
    "gcc/c-tree.h",
    "gcc/c-decl.c",
    "gcc/c-common.c",
    "gcc/c-common.h",
    "gcc/c-pragma.c",
    "gcc/c-objc-common.c",
]

GTYPE_SOURCES = [
    "gcc/coverage.c",
    "gcc/alias.c",
    "gcc/bitmap.c",
    "gcc/cselib.c",
    "gcc/cgraph.c",
    "gcc/dbxout.c",
    "gcc/dwarf2out.c",
    "gcc/dwarf2asm.c",
    "gcc/dojump.c",
    "gcc/emit-rtl.c",
    "gcc/except.c",
    "gcc/explow.c",
    "gcc/expr.c",
    "gcc/function.c",
    "gcc/gcse.c",
    "gcc/integrate.c",
    "gcc/lists.c",
    "gcc/optabs.c",
    "gcc/profile.c",
    "gcc/regclass.c",
    "gcc/reg-stack.c",
    "gcc/cfglayout.c",
    "gcc/sdbout.c",
    "gcc/stor-layout.c",
    "gcc/stringpool.c",
    "gcc/tree.c",
    "gcc/varasm.c",
    "gcc/tree-mudflap.c",
    "gcc/c-objc-common.c",
    "gcc/c-common.c",
    "gcc/c-parse.in",
    "gcc/tree-ssanames.c",
    "gcc/tree-eh.c",
    "gcc/tree-phinodes.c",
    "gcc/tree-cfg.c",
    "gcc/tree-dfa.c",
    "gcc/tree-ssa-propagate.c",
    "gcc/tree-iterator.c",
    "gcc/gimplify.c",
    "gcc/tree-complex.c",
    "gcc/tree-ssa-operands.c",
    "gcc/tree-profile.c",
    "gcc/rtl-profile.c",
    "gcc/tree-nested.c",
    "gcc/config/i386/i386.c",
    "gcc/c-lang.c",
    "gcc/c-decl.c",
    "gcc/c-pragma.c",
    "gcc/gengtype.c",
    "gcc/gengtype-lex.l",
    "gcc/gengtype-yacc.y",
]

BACKEND_OBJECTS = [
    "tree-chrec",
    "tree-scalar-evolution",
    "tree-data-ref",
    "tree-cfg",
    "tree-dfa",
    "tree-eh",
    "tree-ssa",
    "tree-optimize",
    "tree-gimple",
    "gimplify",
    "tree-pretty-print",
    "tree-into-ssa",
    "tree-outof-ssa",
    "tree-ssa-ccp",
    "tree-vn",
    "tree-ssa-dce",
    "tree-ssa-copy",
    "tree-nrv",
    "tree-ssa-copyrename",
    "tree-ssa-pre",
    "tree-ssa-live",
    "tree-ssa-operands",
    "tree-ssa-alias",
    "tree-ssa-phiopt",
    "tree-ssa-forwprop",
    "tree-nested",
    "tree-ssa-dse",
    "tree-ssa-dom",
    "domwalk",
    "tree-tailcall",
    "gimple-low",
    "tree-iterator",
    "tree-phinodes",
    "tree-ssanames",
    "tree-sra",
    "tree-complex",
    "tree-ssa-loop",
    "tree-ssa-loop-niter",
    "tree-ssa-loop-manip",
    "tree-ssa-threadupdate",
    "tree-vectorizer",
    "tree-vect-analyze",
    "tree-vect-transform",
    "tree-ssa-loop-ivcanon",
    "tree-ssa-propagate",
    "tree-ssa-loop-ivopts",
    "tree-if-conv",
    "tree-ssa-loop-unswitch",
    "alias",
    "bb-reorder",
    "bitmap",
    "builtins",
    "caller-save",
    "calls",
    "cfg",
    "cfganal",
    "cfgbuild",
    "cfgcleanup",
    "cfglayout",
    "cfgloop",
    "cfgloopanal",
    "cfgloopmanip",
    "loop-init",
    "loop-unswitch",
    "loop-unroll",
    "cfgrtl",
    "combine",
    "conflict",
    "convert",
    "coverage",
    "cse",
    "cselib",
    "dbxout",
    "ddg",
    "tree-ssa-loop-ch",
    "loop-invariant",
    "tree-ssa-loop-im",
    "debug",
    "df",
    "diagnostic",
    "dojump",
    "dominance",
    "loop-doloop",
    "dwarf2asm",
    "dwarf2out",
    "emit-rtl",
    "except",
    "explow",
    "loop-iv",
    "expmed",
    "expr",
    "final",
    "flow",
    "fold-const",
    "function",
    "gcse",
    "genrtl",
    "ggc-common",
    "global",
    "graph",
    "gtype-desc",
    "haifa-sched",
    "hooks",
    "ifcvt",
    "insn-attrtab",
    "insn-emit",
    "insn-modes",
    "insn-extract",
    "insn-opinit",
    "insn-output",
    "insn-peep",
    "insn-recog",
    "integrate",
    "intl",
    "jump",
    "langhooks",
    "lcm",
    "lists",
    "local-alloc",
    "loop",
    "modulo-sched",
    "optabs",
    "options",
    "opts",
    "params",
    "postreload",
    "postreload-gcse",
    "predict",
    "insn-preds",
    "pointer-set",
    "print-rtl",
    "print-tree",
    "profile",
    "value-prof",
    "var-tracking",
    "real",
    "recog",
    "reg-stack",
    "regclass",
    "regmove",
    "regrename",
    "reload",
    "reload1",
    "reorg",
    "resource",
    "rtl",
    "rtlanal",
    "rtl-error",
    "sbitmap",
    "sched-deps",
    "sched-ebb",
    "sched-rgn",
    "sched-vis",
    "sdbout",
    "simplify-rtx",
    "sreal",
    "stmt",
    "stor-layout",
    "stringpool",
    "targhooks",
    "timevar",
    "toplev",
    "tracer",
    "tree",
    "tree-dump",
    "varasm",
    "varray",
    "vec",
    "version",
    "vmsdbgout",
    "xcoffout",
    "alloc-pool",
    "et-forest",
    "cfghooks",
    "bt-load",
    "pretty-print",
    "ggc-page",
    "web",
    "passes",
    "rtl-profile",
    "tree-profile",
    "rtlhooks",
    "cfgexpand",
    "lambda-mat",
    "lambda-trans",
    "lambda-code",
    "tree-loop-linear",
    "i386",
    "host-linux",
    "tree-inline",
    "cgraph",
    "cgraphunit",
    "tree-nomudflap",
]

C_OBJECTS = [
    "c-parse",
    "c-lang",
    "stub-objc",
    "attribs",
    "c-errors",
    "c-lex",
    "c-pragma",
    "c-decl",
    "c-typeck",
    "c-convert",
    "c-aux-info",
    "c-common",
    "c-opts",
    "c-format",
    "c-semantics",
    "c-incpath",
    "cppdefault",
    "c-ppoutput",
    "c-cppbuiltin",
    "prefix",
    "c-objc-common",
    "c-dump",
    "c-pch",
    "c-gimplify",
    "tree-mudflap",
    "c-pretty-print",
]

COMPILER_FILES = [
    "gcc/gcov-io.c",
    "gcc/tree-chrec.c",
    "gcc/tree-scalar-evolution.c",
    "gcc/tree-data-ref.c",
    "gcc/tree-cfg.c",
    "gcc/tree-dfa.c",
    "gcc/tree-eh.c",
    "gcc/tree-ssa.c",
    "gcc/tree-optimize.c",
    "gcc/tree-gimple.c",
    "gcc/gimplify.c",
    "gcc/tree-pretty-print.c",
    "gcc/tree-into-ssa.c",
    "gcc/tree-outof-ssa.c",
    "gcc/tree-ssa-ccp.c",
    "gcc/tree-vn.c",
    "gcc/tree-ssa-dce.c",
    "gcc/tree-ssa-copy.c",
    "gcc/tree-nrv.c",
    "gcc/tree-ssa-copyrename.c",
    "gcc/tree-ssa-pre.c",
    "gcc/tree-ssa-live.c",
    "gcc/tree-ssa-operands.c",
    "gcc/tree-ssa-alias.c",
    "gcc/tree-ssa-phiopt.c",
    "gcc/tree-ssa-forwprop.c",
    "gcc/tree-nested.c",
    "gcc/tree-ssa-dse.c",
    "gcc/tree-ssa-dom.c",
    "gcc/domwalk.c",
    "gcc/tree-tailcall.c",
    "gcc/gimple-low.c",
    "gcc/tree-iterator.c",
    "gcc/tree-phinodes.c",
    "gcc/tree-ssanames.c",
    "gcc/tree-sra.c",
    "gcc/tree-complex.c",
    "gcc/tree-ssa-loop.c",
    "gcc/tree-ssa-loop-niter.c",
    "gcc/tree-ssa-loop-manip.c",
    "gcc/tree-ssa-threadupdate.c",
    "gcc/tree-vectorizer.c",
    "gcc/tree-vect-analyze.c",
    "gcc/tree-vect-transform.c",
    "gcc/tree-ssa-loop-ivcanon.c",
    "gcc/tree-ssa-propagate.c",
    "gcc/tree-ssa-loop-ivopts.c",
    "gcc/tree-if-conv.c",
    "gcc/tree-ssa-loop-unswitch.c",
    "gcc/alias.c",
    "gcc/bb-reorder.c",
    "gcc/bitmap.c",
    "gcc/builtins.c",
    "gcc/caller-save.c",
    "gcc/calls.c",
    "gcc/cfg.c",
    "gcc/cfganal.c",
    "gcc/cfgbuild.c",
    "gcc/cfgcleanup.c",
    "gcc/cfglayout.c",
    "gcc/cfgloop.c",
    "gcc/cfgloopanal.c",
    "gcc/cfgloopmanip.c",
    "gcc/loop-init.c",
    "gcc/loop-unswitch.c",
    "gcc/loop-unroll.c",
    "gcc/cfgrtl.c",
    "gcc/combine.c",
    "gcc/conflict.c",
    "gcc/convert.c",
    "gcc/coverage.c",
    "gcc/cse.c",
    "gcc/cselib.c",
    "gcc/dbxout.c",
    "gcc/ddg.c",
    "gcc/tree-ssa-loop-ch.c",
    "gcc/loop-invariant.c",
    "gcc/tree-ssa-loop-im.c",
    "gcc/debug.c",
    "gcc/df.c",
    "gcc/diagnostic.c",
    "gcc/dojump.c",
    "gcc/dominance.c",
    "gcc/loop-doloop.c",
    "gcc/dwarf2asm.c",
    "gcc/dwarf2out.c",
    "gcc/emit-rtl.c",
    "gcc/except.c",
    "gcc/explow.c",
    "gcc/loop-iv.c",
    "gcc/expmed.c",
    "gcc/expr.c",
    "gcc/final.c",
    "gcc/flow.c",
    "gcc/fold-const.c",
    "gcc/function.c",
    "gcc/gcse.c",
    "gcc/ggc-common.c",
    "gcc/global.c",
    "gcc/graph.c",
    "gcc/haifa-sched.c",
    "gcc/hooks.c",
    "gcc/ifcvt.c",
    "gcc/integrate.c",
    "gcc/intl.c",
    "gcc/jump.c",
    "gcc/langhooks.c",
    "gcc/lcm.c",
    "gcc/lists.c",
    "gcc/local-alloc.c",
    "gcc/loop.c",
    "gcc/modulo-sched.c",
    "gcc/optabs.c",
    "gcc/opts.c",
    "gcc/params.c",
    "gcc/postreload.c",
    "gcc/postreload-gcse.c",
    "gcc/predict.c",
    "gcc/pointer-set.c",
    "gcc/print-rtl.c",
    "gcc/print-tree.c",
    "gcc/profile.c",
    "gcc/value-prof.c",
    "gcc/var-tracking.c",
    "gcc/real.c",
    "gcc/recog.c",
    "gcc/reg-stack.c",
    "gcc/regclass.c",
    "gcc/regmove.c",
    "gcc/regrename.c",
    "gcc/reload.c",
    "gcc/reload1.c",
    "gcc/reorg.c",
    "gcc/resource.c",
    "gcc/rtl.c",
    "gcc/rtlanal.c",
    "gcc/rtl-error.c",
    "gcc/sbitmap.c",
    "gcc/sched-deps.c",
    "gcc/sched-ebb.c",
    "gcc/sched-rgn.c",
    "gcc/sched-vis.c",
    "gcc/sdbout.c",
    "gcc/simplify-rtx.c",
    "gcc/sreal.c",
    "gcc/stmt.c",
    "gcc/stor-layout.c",
    "gcc/stringpool.c",
    "gcc/targhooks.c",
    "gcc/timevar.c",
    "gcc/toplev.c",
    "gcc/tracer.c",
    "gcc/tree.c",
    "gcc/tree-dump.c",
    "gcc/varasm.c",
    "gcc/varray.c",
    "gcc/vec.c",
    "gcc/version.c",
    "gcc/vmsdbgout.c",
    "gcc/xcoffout.c",
    "gcc/alloc-pool.c",
    "gcc/et-forest.c",
    "gcc/cfghooks.c",
    "gcc/bt-load.c",
    "gcc/pretty-print.c",
    "gcc/ggc-page.c",
    "gcc/web.c",
    "gcc/passes.c",
    "gcc/rtl-profile.c",
    "gcc/tree-profile.c",
    "gcc/rtlhooks.c",
    "gcc/cfgexpand.c",
    "gcc/lambda-mat.c",
    "gcc/lambda-trans.c",
    "gcc/lambda-code.c",
    "gcc/tree-loop-linear.c",
    "gcc/tree-inline.c",
    "gcc/cgraph.c",
    "gcc/cgraphunit.c",
    "gcc/tree-nomudflap.c",
    "gcc/c-lang.c",
    "gcc/stub-objc.c",
    "gcc/attribs.c",
    "gcc/c-errors.c",
    "gcc/c-lex.c",
    "gcc/c-pragma.c",
    "gcc/c-decl.c",
    "gcc/c-typeck.c",
    "gcc/c-convert.c",
    "gcc/c-aux-info.c",
    "gcc/c-common.c",
    "gcc/c-opts.c",
    "gcc/c-format.c",
    "gcc/c-semantics.c",
    "gcc/c-incpath.c",
    "gcc/cppdefault.c",
    "gcc/c-ppoutput.c",
    "gcc/c-cppbuiltin.c",
    "gcc/prefix.c",
    "gcc/c-objc-common.c",
    "gcc/c-dump.c",
    "gcc/c-pch.c",
    "gcc/c-gimplify.c",
    "gcc/tree-mudflap.c",
    "gcc/c-pretty-print.c",
    "gcc/main.c",
    "gcc/config/host-linux.c",
    "gcc/gcov-iov.c",
    "gcc/common.opt",
    "gcc/c.opt",
    "gcc/opt-gather.awk",
    "gcc/opt-functions.awk",
    "gcc/optc-gen.awk",
    "gcc/opth-gen.awk",
]

GCC_FILES = COMPILER_FILES + GTYPE_SOURCES + GCC_HEADERS + ["gcc/" + name + ".c" for name in MACHINE_GENERATORS + GENERATOR_SUPPORT]

FILES = [
    "COPYING",
    "COPYING.LIB",
    "libcpp/ucnid.tab",
    "gcc/libgcc2.c",
    "gcc/crtstuff.c",
    "gcc/libgcov.c",
    "gcc/unwind.inc",
    "gcc/config/i386/linux-unwind.h",
    "gcc/unwind-dw2.c",
    "gcc/unwind-dw2-fde.c",
    "gcc/unwind-sjlj.c",
    "gcc/gthr-gnat.c",
    "gcc/unwind-c.c",
    "gcc/gcc.c",
    "gcc/gccspec.c",
    "gcc/cppspec.c",
    "gcc/ginclude/float.h",
    "gcc/ginclude/iso646.h",
    "gcc/ginclude/stdarg.h",
    "gcc/ginclude/stdbool.h",
    "gcc/ginclude/stddef.h",
    "gcc/ginclude/varargs.h",
] + LIBRARY_HEADERS + ["libiberty/" + name + ".c" for name in LIBIBERTY] + ["libcpp/" + name + ".c" for name in LIBCPP]

download_file(
    name = "gcc-core-4.0.4.tar.bz2",
    hash = "e9bf58c761a4f988311aef6b41f12fd5c7e51d09477468fb73826aecc1be32e7",
    urls = ["https://mirrors.kernel.org/gnu/gcc/gcc-4.0.4/gcc-core-4.0.4.tar.bz2"],
)

generate(
    name = "gcc.tar",
    args = [
        "--file",
        "$(location :gcc-core-4.0.4.tar.bz2)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unbz2",
)

untar(
    name = "gcc-4.0.4",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    # The shipped header is a test fixture, never a compiler input.
    files = FILES + GCC_FILES + ["libcpp/ucnid.h"],
    input = ":gcc.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

c_object(
    name = "ucnid.o",
    src = "cellar//bootstrap/stage1/gcc40:generators/ucnid.c",
    flags = [
        "-O2",
        "-Werror",
    ],
    headers = [MUSL + ":headers"],
    toolchain = PREDECESSOR,
)

c_binary(
    name = "ucnid",
    libraries = LIBC,
    objects = CRT + [":ucnid.o"] + CRTN,
    toolchain = PREDECESSOR,
)

generate(
    name = "ucnid.h",
    args = ["$(location :gcc-4.0.4[libcpp/ucnid.tab])"],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = ":ucnid",
)

command_test(
    name = "ucnid-regeneration",
    args = [
        "$(location :ucnid.h)",
        "$(location :gcc-4.0.4[libcpp/ucnid.h])",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

[
    [
        write_file(
            name = name + ".tab",
            content = content,
        ),
        command_test(
            name = "ucnid-" + name,
            args = [
                "1",
                "$(location :ucnid)",
                "$(location :" + name + ".tab)",
            ],
            tool = "cellar//bootstrap/stage1/tools:expect-exit",
        ),
    ]
    for name, content in [
        ("missing-template", "[C99]\n; Latin\n00aa\n"),
        ("missing-standard", "[table]\n%%\n; Latin\n00aa\n"),
        ("invalid-range", "[table]\n%%\n[C99]\n; Latin\n00aa-10000\n"),
        ("language-overlap", "[table]\n%%\n[C99]\n; Latin\n00aa\n; Greek\n00aa\n"),
    ]
]

# Fixed Linux/x86_64 musl configuration for the build libraries.
LIBRARY_CONFIG_ON = [
    "STDC_HEADERS",
    "TIME_WITH_SYS_TIME",
    "STRING_WITH_STRINGS",
    "HAVE_ALLOCA",
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
    "HAVE_FCNTL_H",
    "HAVE_FFS",
    "HAVE_FORK",
    "HAVE_GETCWD",
    "HAVE_GETPAGESIZE",
    "HAVE_GETRUSAGE",
    "HAVE_GETTIMEOFDAY",
    "HAVE_INDEX",
    "HAVE_INSQUE",
    "HAVE_INTTYPES_H",
    "HAVE_LIMITS_H",
    "HAVE_MALLOC_H",
    "HAVE_MEMCHR",
    "HAVE_MEMCMP",
    "HAVE_MEMCPY",
    "HAVE_MEMMOVE",
    "HAVE_MEMORY_H",
    "HAVE_MEMPCPY",
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
    "HAVE_SNPRINTF",
    "HAVE_STDDEF_H",
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
    "HAVE_STRRCHR",
    "HAVE_STRSIGNAL",
    "HAVE_STRSTR",
    "HAVE_STRTOD",
    "HAVE_STRTOL",
    "HAVE_STRTOUL",
    "HAVE_SYSCONF",
    "HAVE_SYS_FILE_H",
    "HAVE_SYS_MMAN_H",
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
    "HAVE_VSNPRINTF",
    "HAVE_VSPRINTF",
    "HAVE_WAITPID",
    "HAVE_WORKING_FORK",
    "HAVE_WORKING_VFORK",
    "HAVE___FSETLOCKING",
    "HAVE_DECL_ABORT",
    "HAVE_DECL_BASENAME",
    "HAVE_DECL_ERRNO",
    "HAVE_DECL_GETOPT",
    "HAVE_ICONV",
    "HAVE_ICONV_H",
    "HAVE_LANGINFO_CODESET",
    "HAVE_LOCALE_H",
    "HAVE_CLEARERR_UNLOCKED",
    "HAVE_DECL_CLEARERR_UNLOCKED",
    "HAVE_FEOF_UNLOCKED",
    "HAVE_DECL_FEOF_UNLOCKED",
    "HAVE_FERROR_UNLOCKED",
    "HAVE_DECL_FERROR_UNLOCKED",
    "HAVE_FFLUSH_UNLOCKED",
    "HAVE_DECL_FFLUSH_UNLOCKED",
    "HAVE_FGETC_UNLOCKED",
    "HAVE_DECL_FGETC_UNLOCKED",
    "HAVE_FGETS_UNLOCKED",
    "HAVE_DECL_FGETS_UNLOCKED",
    "HAVE_FILENO_UNLOCKED",
    "HAVE_DECL_FILENO_UNLOCKED",
    "HAVE_FPUTC_UNLOCKED",
    "HAVE_DECL_FPUTC_UNLOCKED",
    "HAVE_FPUTS_UNLOCKED",
    "HAVE_DECL_FPUTS_UNLOCKED",
    "HAVE_FREAD_UNLOCKED",
    "HAVE_DECL_FREAD_UNLOCKED",
    "HAVE_FWRITE_UNLOCKED",
    "HAVE_DECL_FWRITE_UNLOCKED",
    "HAVE_GETCHAR_UNLOCKED",
    "HAVE_DECL_GETCHAR_UNLOCKED",
    "HAVE_GETC_UNLOCKED",
    "HAVE_DECL_GETC_UNLOCKED",
    "HAVE_PUTCHAR_UNLOCKED",
    "HAVE_DECL_PUTCHAR_UNLOCKED",
    "HAVE_PUTC_UNLOCKED",
    "HAVE_DECL_PUTC_UNLOCKED",
]

LIBRARY_CONFIG_VALUES = {
    "SIZEOF_INT": "4",
    "SIZEOF_LONG": "8",
    "SIZEOF_LONG_LONG": "8",
    "SIZEOF_SIZE_T": "8",
    "SIZEOF_VOID_P": "8",
    "BYTEORDER": "1234",
    "STACK_DIRECTION": "-1",
    "HOST_WIDE_INT": "long",
    "UNSIGNED_64BIT_TYPE": "unsigned long",
    "ICONV_CONST": "",
    "PACKAGE": "\"gcc\"",
    "PACKAGE_VERSION": "\"4.0.4\"",
}

write_file(
    name = "library-config.h",
    content = "#ifndef GCC40_LIBRARY_CONFIG_H\n#define GCC40_LIBRARY_CONFIG_H 1\n#ifndef _GNU_SOURCE\n#define _GNU_SOURCE 1\n#endif\n" + "\n".join(["#define " + name + " 1" for name in LIBRARY_CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in LIBRARY_CONFIG_VALUES.items()]) + "\n#endif\n",
)

write_file(
    name = "localedir.h",
    content = '#define LOCALEDIR "/nonexistent-bootstrap-locale"\n',
)

[
    generate(
        name = name,
        args = [
            "$(location :gcc-4.0.4[" + source + "])",
            "$(location cellar//bootstrap/stage1/gcc40:patches/" + patch + ".before)",
            "$(location cellar//bootstrap/stage1/gcc40:patches/" + patch + ".after)",
        ],
        tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
    )
    for name, source, patch in [
        ("make-temp-file.c", "libiberty/make-temp-file.c", "tmpdir"),
        ("obstack.h", "include/obstack.h", "obstack"),
    ]
]

filegroup(
    name = "library-source",
    srcs = {path: ":gcc-4.0.4[" + path + "]" for path in FILES} | {
        "include/obstack.h": ":obstack.h",
        "libiberty/config.h": ":library-config.h",
        "libiberty/make-temp-file.c": ":make-temp-file.c",
        "libcpp/config.h": ":library-config.h",
        "libcpp/localedir.h": ":localedir.h",
        "libcpp/ucnid.h": ":ucnid.h",
    },
)

[
    c_object(
        name = "ib-" + name + ".o",
        src = ":library-source[libiberty/" + name + ".c]",
        defines = ["HAVE_CONFIG_H=1"],
        flags = [
            "-O2",
            "-Werror",
        ],
        headers = [
            ":library-source",
            MUSL + ":headers",
        ],
        includes = [
            ":library-source[include]",
            ":library-source[libiberty]",
        ],
        object_name = name + ".o",
        toolchain = PREDECESSOR,
    )
    for name in LIBIBERTY
]

c_library(
    name = "libiberty.a",
    objects = [":ib-" + name + ".o" for name in LIBIBERTY],
    output = "libiberty.a",
    toolchain = PREDECESSOR,
)

[
    c_object(
        name = "cpp-" + name + ".o",
        src = ":library-source[libcpp/" + name + ".c]",
        flags = [
            "-O2",
            "-Werror",
        ],
        headers = [
            ":library-source",
            MUSL + ":headers",
        ],
        # do not sort
        includes = [
            ":library-source[libcpp]",
            ":library-source[libcpp/include]",
            ":library-source[include]",
        ],
        object_name = name + ".o",
        toolchain = PREDECESSOR,
    )
    for name in LIBCPP
]

c_library(
    name = "libcpp.a",
    objects = [":cpp-" + name + ".o" for name in LIBCPP],
    output = "libcpp.a",
    toolchain = PREDECESSOR,
)

[
    [
        c_object(
            name = name + "-test.o",
            src = "cellar//bootstrap/stage1/gcc40:tests/" + name + ".c",
            flags = [
                "-O2",
                "-Werror",
            ],
            headers = [
                ":library-source",
                MUSL + ":headers",
            ],
            # do not sort
            includes = [
                ":library-source[libcpp]",
                ":library-source[libcpp/include]",
                ":library-source[include]",
            ],
            toolchain = PREDECESSOR,
        ),
        c_binary(
            name = name + "-test-bin",
            libraries = [
                ":libcpp.a",
                ":libiberty.a",
            ] + LIBC,
            objects = CRT + [":" + name + "-test.o"] + CRTN,
            toolchain = PREDECESSOR,
        ),
    ]
    for name in [
        "libiberty",
        "cpp",
    ]
]

command_test(
    name = "libiberty-test",
    tool = ":libiberty-test-bin",
)

generate(
    name = "libiberty-temp-run",
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
        "$(location :libiberty-temp-run[passed])",
        "$(location :passed)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

command_test(
    name = "libiberty-missing-tmpdir",
    args = [
        "1",
        "$(location :libiberty-test-bin)",
        "temp",
    ],
    env = {"TMPDIR": "/nonexistent-bootstrap-tmp"},
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

write_file(
    name = "cpp-input.c",
    content = """#include "included.h"
#define CAT(a,b) a ## b
#define STR_(x) #x
#define STR(x) STR_(x)
#define PAIR(x,...) x + __VA_ARGS__
#if (0xffffffffffffffffULL >> 63) != 1
#error broken 64-bit evaluation
#endif
int CAT(na,me) = VALUE;
const char *message = STR(hello world);
const char *omega = "\\u03b1";
int sum = PAIR(3,4);
""",
)

write_file(
    name = "included.h",
    content = "#define VALUE 42\n",
)

write_file(
    name = "cpp-bad.c",
    content = "#include <unavailable-bootstrap-header.h>\n",
)

write_file(
    name = "cpp-expected",
    content = "int\nname\n=\n42\n;\nconst\nchar\n*\nmessage\n=\n\"hello world\"\n;\nconst\nchar\n*\nomega\n=\n\"\\u03b1\"\n;\nint\nsum\n=\n3\n+\n4\n;\n",
)

filegroup(
    name = "cpp-fixtures",
    srcs = {
        "input.c": ":cpp-input.c",
        "included.h": ":included.h",
    },
)

generate(
    name = "cpp-result",
    args = ["$(location :cpp-fixtures[input.c])"],
    capture = "cellar//bootstrap/stage1/tools:capture",
    inputs = [":cpp-fixtures"],
    tool = ":cpp-test-bin",
)

command_test(
    name = "cpp-tokens",
    args = [
        "$(location :cpp-result)",
        "$(location :cpp-expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

command_test(
    name = "cpp-missing-include",
    args = [
        "1",
        "$(location :cpp-test-bin)",
        "$(location :cpp-bad.c)",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

TARGET_HEADERS = [
    "i386/biarch64.h",
    "i386/i386.h",
    "i386/unix.h",
    "i386/att.h",
    "dbxelf.h",
    "elfos.h",
    "svr4.h",
    "linux.h",
    "i386/x86-64.h",
    "i386/linux64.h",
]

GCC_CONFIG_ON = [
    "HAVE_LONG_LONG",
    "HAVE_STDBOOL_H",
    "HAVE__BOOL",
    "HAVE_DESIGNATED_INITIALIZERS",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_TIMES_H",
    "HAVE_SYS_SELECT_H",
    "HAVE_SYS_RESOURCE_H",
    "HAVE_GETRLIMIT",
    "HAVE_SETRLIMIT",
    "HAVE_GETTIMEOFDAY",
    "HAVE_CLOCK_T",
    "HAVE_STRUCT_TMS",
    "HAVE_TIMES",
    "HAVE_DECL_ATOF",
    "HAVE_DECL_ATOL",
    "HAVE_DECL_CALLOC",
    "HAVE_DECL_CLOCK",
    "HAVE_DECL_FREE",
    "HAVE_DECL_GETCWD",
    "HAVE_DECL_GETENV",
    "HAVE_DECL_GETPAGESIZE",
    "HAVE_DECL_MALLOC",
    "HAVE_DECL_REALLOC",
    "HAVE_DECL_SBRK",
    "HAVE_DECL_SNPRINTF",
    "HAVE_DECL_STRSTR",
    "HAVE_DECL_TIMES",
    "HAVE_DECL_VASPRINTF",
    "HAVE_INTTYPES_H",
    "HAVE_STDINT_H",
    "HAVE_UINTPTR_T",
    "HAVE_AS_DWARF2_DEBUG_LINE",
    "HAVE_AS_GDWARF2_DEBUG_FLAG",
    "HAVE_AS_GOTOFF_IN_DATA",
    "HAVE_AS_GSTABS_DEBUG_FLAG",
    "HAVE_AS_LEB128",
    "HAVE_AS_TLS",
    "HAVE_GAS_BALIGN_AND_P2ALIGN",
    "HAVE_GAS_MAX_SKIP_P2ALIGN",
    "HAVE_GAS_HIDDEN",
    "HAVE_GAS_COMDAT_GROUP",
    "HAVE_GAS_FILDS_FISTS",
    "HAVE_GAS_SHF_MERGE",
    "HAVE_GAS_SUBSECTION_ORDERING",
    "HAVE_GAS_WEAK",
    "HAVE_LD_EH_FRAME_HDR",
    "HAVE_LD_RO_RW_SECTION_MIXING",
    "HAVE_LD_AS_NEEDED",
    "HAVE_LD_PIE",
    "HAVE_LD_STATIC_DYNAMIC",
    "HAVE_LD_DEMANGLE",
    "HAVE_INITFINI_ARRAY",
    "HAVE_MMAP_FILE",
    "HAVE_MMAP_ANON",
    "HAVE_MMAP_DEV_ZERO",
    "HAVE_LSTAT",
    "HAVE_FTRUNCATE",
    "HAVE_FSTAT",
    "HAVE_GETRUSAGE",
    "HAVE_SETLOCALE",
    "HAVE_LANGINFO_CODESET",
    "NEED_64BIT_HOST_WIDE_INT",
]

GCC_CONFIG_VALUES = {
    "SIZEOF_SHORT": "2",
    "SIZEOF_CHAR": "1",
    "SIZEOF_DOUBLE": "8",
    "SIZEOF_LONG_DOUBLE": "16",
    "GETGROUPS_T": "gid_t",
    "HOST_EXECUTABLE_SUFFIX": "\"\"",
    "HOST_OBJECT_SUFFIX": "\".o\"",
    "DEFAULT_USE_CXA_ATEXIT": "1",
    "CONFIG_SJLJ_EXCEPTIONS": "0",
    "EXTRA_MODES_FILE": "\"config/i386/i386-modes.def\"",
    "TARGET_SYSTEM_ROOT": "\"/nonexistent-bootstrap-sysroot\"",
}

write_file(
    name = "auto-host.h",
    content = '#include "library-config.h"\n' + "\n".join(["#define " + name + " 1" for name in GCC_CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in GCC_CONFIG_VALUES.items()]) + "\n",
)

[
    write_file(
        name = name,
        content = '#ifndef GCC40_CONFIG_H\n#define GCC40_CONFIG_H 1\n#include "auto-host.h"\n#ifdef IN_GCC\n#include "ansidecl.h"\n#endif\n#endif\n',
    )
    for name in [
        "config.h",
        "bconfig.h",
    ]
]

write_file(
    name = "tm.h",
    content = "#ifndef GCC40_TM_H\n#define GCC40_TM_H 1\n#ifdef IN_GCC\n" + "\n".join(['#include "config/' + path + '"' for path in TARGET_HEADERS]) + '\n#include "defaults.h"\n#endif\n#if defined IN_GCC && !defined GENERATOR_FILE && !defined USED_FOR_TARGET\n#include "insn-constants.h"\n#include "insn-flags.h"\n#endif\n#endif\n',
)

write_file(
    name = "tm_p.h",
    content = '#include "config/i386/i386-protos.h"\n#include "tm-preds.h"\n',
)

write_file(
    name = "gencheck.h",
    content = "/* C has no additional tree codes. */\n",
)

filegroup(
    name = "gcc-source",
    srcs = {path: ":gcc-4.0.4[" + path + "]" for path in GCC_FILES} | {
        "gcc/config/i386/i386.c": ":i386.c",
        "gcc/sched-int.h": ":sched-int.h",
        "gcc/ggc-page.c": ":ggc-page.c",
        "gcc/version.c": ":version.c",
        "gcc/gcov-iov.c": ":gcov-iov.c",
        "include": ":library-source[include]",
        "libcpp": ":library-source[libcpp]",
    } | {"gcc/" + name: ":" + name for name in [
        "library-config.h",
        "auto-host.h",
        "config.h",
        "bconfig.h",
        "tm.h",
        "tm_p.h",
        "gencheck.h",
    ]},
)

GENERATOR_DEFINES = [
    "_GNU_SOURCE=1",
    "IN_GCC=1",
    "GENERATOR_FILE=1",
]

GENERATOR_INCLUDES = [
    ":gcc-source[gcc]",
    ":gcc-source[include]",
    ":library-source[libcpp/include]",
]

[
    c_object(
        name = name + ".o",
        src = ":gcc-source[gcc/" + name + ".c]",
        defines = GENERATOR_DEFINES,
        flags = [
            "-O2",
            "-Werror",
        ],
        headers = [
            ":gcc-source",
            MUSL + ":headers",
        ],
        includes = GENERATOR_INCLUDES,
        object_name = name + ".o",
        toolchain = PREDECESSOR,
    )
    for name in [
        "gencheck",
        "gengenrtl",
        "genmodes",
        "errors",
    ]
]

[
    c_binary(
        name = name,
        libraries = [":libiberty.a"] + LIBC,
        objects = CRT + [
            ":" + name + ".o",
            ":errors.o",
        ] + CRTN,
        toolchain = PREDECESSOR,
    )
    for name in [
        "gencheck",
        "gengenrtl",
        "genmodes",
    ]
]

[
    generate(
        name = output,
        args = args,
        capture = "cellar//bootstrap/stage1/tools:capture",
        output = output,
        tool = ":" + tool,
    )
    for output, tool, args in [
        ("tree-check.h", "gencheck", []),
        (
            "genrtl.h",
            "gengenrtl",
            ["-h"],
        ),
        ("genrtl.c", "gengenrtl", []),
        (
            "insn-modes.h",
            "genmodes",
            ["-h"],
        ),
        (
            "min-insn-modes.c",
            "genmodes",
            ["-m"],
        ),
        ("insn-modes.c", "genmodes", []),
    ]
]

filegroup(
    name = "mode-headers",
    srcs = {name: ":" + name for name in [
        "tree-check.h",
        "genrtl.h",
        "insn-modes.h",
    ]},
)

[
    c_object(
        name = name + ".o",
        src = ":min-insn-modes.c" if name == "min-insn-modes" else ":gcc-source[gcc/" + name + ".c]",
        defines = GENERATOR_DEFINES,
        flags = [
            "-O2",
            "-Werror",
        ],
        headers = [
            ":gcc-source",
            ":mode-headers",
            ":gtype-output",
            MUSL + ":headers",
        ] + ([":extract-headers"] if name == "genextract" else []),
        includes = ([":extract-headers"] if name == "genextract" else []) + [
            ":gtype-output",
            ":mode-headers",
        ] + GENERATOR_INCLUDES,
        object_name = name + ".o",
        toolchain = PREDECESSOR,
    )
    for name in GENERATOR_SUPPORT + MACHINE_GENERATORS + ["min-insn-modes"]
    if name not in [
        "gencheck",
        "gengenrtl",
        "genmodes",
        "errors",
    ]
]

BUILD_RTL = [
    ":rtl.o",
    ":read-rtl.o",
    ":ggc-none.o",
    ":min-insn-modes.o",
]

BUILD_EARLY = [
    ":gensupport.o",
    ":dummy-conditions.o",
]

[
    c_binary(
        name = name,
        libraries = [":libiberty.a"] + LIBC,
        objects = CRT + [":" + name + ".o"] + BUILD_RTL + BUILD_EARLY + [":errors.o"] + ([":print-rtl.o"] if name == "genpreds" else []) + CRTN,
        toolchain = PREDECESSOR,
    )
    for name in [
        "genconstants",
        "genconditions",
        "genpreds",
    ]
]

[
    generate(
        name = output,
        args = args + ["config/i386/i386.md"],
        capture = "cellar//bootstrap/stage1/tools:capture",
        inputs = [":gcc-source"],
        output = output,
        tool = ":" + tool,
        working_directory = ":gcc-source[gcc]",
    )
    for output, tool, args in [
        ("insn-constants.h", "genconstants", []),
        ("insn-conditions.c", "genconditions", []),
        (
            "tm-preds.h",
            "genpreds",
            ["-h"],
        ),
        ("insn-preds.c", "genpreds", []),
    ]
]

filegroup(
    name = "early-headers",
    srcs = {name: ":" + name for name in [
        "tree-check.h",
        "options.h",
        "genrtl.h",
        "insn-modes.h",
        "insn-constants.h",
        "tm-preds.h",
    ]},
)

c_object(
    name = "insn-conditions.o",
    src = ":insn-conditions.c",
    defines = GENERATOR_DEFINES,
    flags = [
        "-O2",
        "-Werror",
    ],
    headers = [
        ":gcc-source",
        ":early-headers",
        MUSL + ":headers",
    ],
    includes = [":early-headers"] + GENERATOR_INCLUDES,
    toolchain = PREDECESSOR,
)

[
    c_binary(
        name = name,
        libraries = [":libiberty.a"] + LIBC,
        objects = CRT + [":" + name + ".o"] + BUILD_RTL + [
            ":gensupport.o",
            ":insn-conditions.o",
            ":print-rtl.o",
            ":errors.o",
        ] + ([
            ":genautomata.o",
            ":varray.o",
        ] if name == "genattrtab" else []) + CRTN,
        toolchain = PREDECESSOR,
    )
    for name in [
        "genconfig",
        "genflags",
        "gencodes",
        "genemit",
        "genopinit",
        "genrecog",
        "genextract",
        "genpeep",
        "genattr",
        "genoutput",
        "genattrtab",
    ]
]

MACHINE_OUTPUTS = [
    ("insn-config.h", "genconfig"),
    ("insn-flags.h", "genflags"),
    ("insn-codes.h", "gencodes"),
    ("insn-emit.c", "genemit"),
    ("insn-opinit.c", "genopinit"),
    ("insn-recog.c", "genrecog"),
    ("insn-extract.c", "genextract"),
    ("insn-peep.c", "genpeep"),
    ("insn-attr.h", "genattr"),
    ("insn-output.c", "genoutput"),
    ("insn-attrtab.c", "genattrtab"),
]

[
    generate(
        name = output,
        args = ["config/i386/i386.md"],
        capture = "cellar//bootstrap/stage1/tools:capture",
        inputs = [":gcc-source"],
        output = output,
        tool = ":" + tool,
        working_directory = ":gcc-source[gcc]",
    )
    for output, tool in MACHINE_OUTPUTS
]

filegroup(
    name = "machine-generated",
    srcs = {name: ":" + name for name in [
        "tree-check.h",
        "genrtl.h",
        "genrtl.c",
        "insn-modes.h",
        "insn-modes.c",
        "min-insn-modes.c",
        "insn-constants.h",
        "insn-conditions.c",
        "tm-preds.h",
        "insn-preds.c",
    ] + [entry[0] for entry in MACHINE_OUTPUTS]},
)

filegroup(
    name = "extract-headers",
    srcs = {"insn-config.h": ":insn-config.h"},
)

# The metadata uses stable logical names; only opening the input adds its
# declared directory. Generated diagnostics and C never contain Buck paths.
write_file(
    name = "gtyp-gen.h",
    content = 'static const char *const srcdir = "gcc";\n' +
              "static const char *const lang_files[] = {\n" + ",\n".join(['"' + path + '"' for path in GT_LANG_FILES]) + ", NULL};\n" +
              "static const char *const langs_for_lang_files[] = {\n" + ",\n".join(['"c"' for path in GT_LANG_FILES]) + ", NULL};\n" +
              "static const char *const all_files[] = {\n" + ",\n".join(['"' + path + '"' for path in GTFILES]) + ", NULL};\n" +
              'static const char *const lang_dir_names[] = {"c", NULL};\n',
)

generate(
    name = "gengtype-lex-source",
    args = [
        "$(location :gcc-source[gcc/gengtype-lex.l])",
        "$(location cellar//bootstrap/stage1/gcc40:patches/gtype-input.before)",
        "$(location cellar//bootstrap/stage1/gcc40:patches/gtype-input.after)",
    ],
    tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
)

generate(
    name = "gengtype-parser",
    args = [
        "--no-lines",
        "-d",
        "-o",
        "gengtype-yacc.c",
        "$(location :gcc-source[gcc/gengtype-yacc.y])",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = [
        "gengtype-yacc.c",
        "gengtype-yacc.h",
    ],
    tool = "cellar//bootstrap/stage1/bison:bison",
)

generate(
    name = "gengtype-scanner",
    args = [
        "--noline",
        "-o",
        "gengtype-lex.c",
        "$(location :gengtype-lex-source)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    files = ["gengtype-lex.c"],
    tool = "cellar//bootstrap/stage1/flex:flex",
)

filegroup(
    name = "gengtype-headers",
    srcs = {
        "gtyp-gen.h": ":gtyp-gen.h",
        "gengtype-yacc.h": ":gengtype-parser[gengtype-yacc.h]",
    },
)

[
    c_object(
        name = name + ".o",
        src = src,
        defines = GENERATOR_DEFINES,
        flags = [
            "-O2",
            "-Werror",
        ],
        headers = [
            ":gcc-source",
            ":gengtype-headers",
            MUSL + ":headers",
        ],
        includes = [":gengtype-headers"] + GENERATOR_INCLUDES,
        object_name = name + ".o",
        toolchain = PREDECESSOR,
    )
    for name, src in [
        ("gengtype", ":gcc-source[gcc/gengtype.c]"),
        ("gengtype-lex", ":gengtype-scanner[gengtype-lex.c]"),
        ("gengtype-yacc", ":gengtype-parser[gengtype-yacc.c]"),
    ]
]

c_binary(
    name = "gengtype",
    libraries = [":libiberty.a"] + LIBC,
    objects = CRT + [
        ":gengtype.o",
        ":gengtype-lex.o",
        ":gengtype-yacc.o",
        ":errors.o",
    ] + CRTN,
    toolchain = PREDECESSOR,
)

GTYPE_OUTPUTS = [
    "gt-cgraph.h",
    "gt-coverage.h",
    "gtype-desc.h",
    "gtype-desc.c",
    "gt-except.h",
    "gt-function.h",
    "gt-integrate.h",
    "gt-tree.h",
    "gt-varasm.h",
    "gt-emit-rtl.h",
    "gt-explow.h",
    "gt-stor-layout.h",
    "gt-regclass.h",
    "gt-lists.h",
    "gt-alias.h",
    "gt-cselib.h",
    "gt-gcse.h",
    "gt-expr.h",
    "gt-sdbout.h",
    "gt-optabs.h",
    "gt-bitmap.h",
    "gt-dojump.h",
    "gt-dwarf2out.h",
    "gt-reg-stack.h",
    "gt-dwarf2asm.h",
    "gt-dbxout.h",
    "gt-c-common.h",
    "gt-c-decl.h",
    "gt-c-parse.h",
    "gt-c-pragma.h",
    "gtype-c.h",
    "gt-cfglayout.h",
    "gt-tree-mudflap.h",
    "gt-tree-complex.h",
    "gt-tree-eh.h",
    "gt-tree-ssanames.h",
    "gt-tree-iterator.h",
    "gt-gimplify.h",
    "gt-tree-phinodes.h",
    "gt-tree-cfg.h",
    "gt-tree-nested.h",
    "gt-tree-ssa-operands.h",
    "gt-tree-ssa-propagate.h",
    "gt-stringpool.h",
    "gt-i386.h",
]

generate(
    name = "gtype-output",
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"BOOTSTRAP_GCC_SOURCE": "$(location :gcc-source)"},
    files = GTYPE_OUTPUTS,
    inputs = [":gcc-source"],
    tool = ":gengtype",
)

[
    c_object(
        name = name + ".o",
        src = src,
        defines = GENERATOR_DEFINES,
        flags = [
            "-O2",
            "-Werror",
        ],
        headers = [
            ":gcc-source",
            ":machine-generated",
            ":gtype-output",
            MUSL + ":headers",
        ],
        includes = [
            ":gtype-output",
            ":machine-generated",
        ] + GENERATOR_INCLUDES,
        toolchain = PREDECESSOR,
    )
    for name, src in [
        ("genrtl-test-support", ":genrtl.c"),
        ("rtl-test", "cellar//bootstrap/stage1/gcc40:tests/rtl.c"),
        ("generated-files-test", "cellar//bootstrap/stage1/gcc40:tests/generated-files.c"),
    ]
]

c_binary(
    name = "rtl-test-bin",
    libraries = [":libiberty.a"] + LIBC,
    objects = CRT + [
        ":rtl-test.o",
        ":genrtl-test-support.o",
        ":rtl.o",
        ":ggc-none.o",
        ":min-insn-modes.o",
        ":insn-conditions.o",
        ":errors.o",
    ] + CRTN,
    toolchain = PREDECESSOR,
)

command_test(
    name = "rtl-test",
    tool = ":rtl-test-bin",
)

c_binary(
    name = "generated-files-test-bin",
    libraries = LIBC,
    objects = CRT + [":generated-files-test.o"] + CRTN,
    toolchain = PREDECESSOR,
)

command_test(
    name = "generated-source-paths",
    args = ["$(location :machine-generated[" + name + "])" for name in [
        "tree-check.h",
        "genrtl.h",
        "genrtl.c",
        "insn-modes.h",
        "insn-modes.c",
        "min-insn-modes.c",
        "insn-constants.h",
        "insn-conditions.c",
        "tm-preds.h",
        "insn-preds.c",
    ] + [entry[0] for entry in MACHINE_OUTPUTS]] + ["$(location :gtype-output[" + name + "])" for name in GTYPE_OUTPUTS],
    tool = ":generated-files-test-bin",
)

write_file(
    name = "invalid.md",
    content = "(define_insn \"truncated\" [ (set\n",
)

command_test(
    name = "machine-description-diagnostic",
    args = [
        "1",
        "$(location :genconfig)",
        "$(location :invalid.md)",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

command_test(
    name = "gengtype-missing-source",
    args = [
        "1",
        "$(location :gengtype)",
    ],
    env = {"BOOTSTRAP_GCC_SOURCE": ""},
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

[
    generate(
        name = name + ".c",
        args = [
            "$(location :gcc-4.0.4[" + source + "])",
            "$(location cellar//bootstrap/stage1/gcc40:patches/" + patch + ".before)",
            "$(location cellar//bootstrap/stage1/gcc40:patches/" + patch + ".after)",
        ],
        tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
    )
    for name, source, patch in [
        ("i386-declaration", "gcc/config/i386/i386.c", "attributes"),
        ("version", "gcc/version.c", "version"),
        ("gcov-iov", "gcc/gcov-iov.c", "gcov-name"),
    ]
]

generate(
    name = "c-parse.y",
    args = [
        "-e",
        "/^@@ifobjc.*/,/^@@end_ifobjc.*/d",
        "-e",
        "/^@@ifc.*/d",
        "-e",
        "/^@@end_ifc.*/d",
        "-e",
        "s/YYLEX/yylex()/g",
        "$(location :gcc-source[gcc/c-parse.in])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

generate(
    name = "c-parser",
    args = [
        "--no-lines",
        "-o",
        "c-parse.c",
        "$(location :c-parse.y)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = ["c-parse.c"],
    tool = "cellar//bootstrap/stage1/bison:bison",
)

generate(
    name = "optionlist",
    args = [
        "-f",
        "$(location :gcc-source[gcc/opt-gather.awk])",
        "$(location :gcc-source[gcc/c.opt])",
        "$(location :gcc-source[gcc/common.opt])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/gawk:gawk",
)

[
    generate(
        name = output,
        args = [
            "-f",
            "$(location :gcc-source[gcc/opt-functions.awk])",
            "-f",
            "$(location :gcc-source[gcc/" + script + "])",
        ] + args,
        capture = "cellar//bootstrap/stage1/tools:capture",
        output = output,
        stdin = ":optionlist",
        tool = "cellar//bootstrap/stage1/gawk:gawk",
    )
    for output, script, args in [
        (
            "options.c",
            "optc-gen.awk",
            [
                "-v",
                "header_name=options.h",
            ],
        ),
        ("options.h", "opth-gen.awk", []),
    ]
]

c_object(
    name = "gcov-iov.o",
    src = ":gcc-source[gcc/gcov-iov.c]",
    defines = GENERATOR_DEFINES,
    flags = [
        "-O2",
        "-Werror",
    ],
    headers = [
        ":gcc-source",
        MUSL + ":headers",
    ],
    includes = GENERATOR_INCLUDES,
    toolchain = PREDECESSOR,
)

c_binary(
    name = "gcov-iov",
    libraries = LIBC,
    objects = CRT + [":gcov-iov.o"] + CRTN,
    toolchain = PREDECESSOR,
)

generate(
    name = "gcov-iov.h",
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = ":gcov-iov",
)

filegroup(
    name = "frontend-generated",
    srcs = {
        "c-parse.c": ":c-parser[c-parse.c]",
        "options.c": ":options.c",
        "options.h": ":options.h",
        "gcov-iov.h": ":gcov-iov.h",
    },
)

COMPILER_DEFINES = [
    "_GNU_SOURCE=1",
    "IN_GCC=1",
    "HAVE_CONFIG_H=1",
    'TARGET_NAME="x86_64-cellar-linux-musl"',
    'TARGET_MACHINE="x86_64-cellar-linux-musl"',
    'HOST_MACHINE="x86_64-cellar-linux-musl"',
    'PREFIX="/nonexistent-bootstrap-gcc"',
    'LOCALEDIR="/nonexistent-bootstrap-locale"',
    'STANDARD_INCLUDE_DIR="/include"',
    'GCC_INCLUDE_DIR="/nonexistent-bootstrap-gcc/include"',
]

COMPILER_INCLUDES = [
    ":frontend-generated",
    ":machine-generated",
    ":gtype-output",
] + GENERATOR_INCLUDES

COMPILER_HEADERS = [
    ":frontend-generated",
    ":machine-generated",
    ":gtype-output",
    ":gcc-source",
    MUSL + ":headers",
]

[
    c_object(
        name = "cc-" + name + ".o",
        src = src,
        defines = COMPILER_DEFINES,
        flags = [
            "-O2",
            "-Werror",
        ],
        headers = COMPILER_HEADERS,
        includes = COMPILER_INCLUDES,
        object_name = "cc{}.o".format(i),
        toolchain = PREDECESSOR,
    )
    for i, (name, src) in enumerate(
        [(
            name,
            ":gcc-source[gcc/" + name + ".c]",
        ) for name in BACKEND_OBJECTS + C_OBJECTS + ["main"] if name not in [
            "i386",
            "host-linux",
            "genrtl",
            "gtype-desc",
            "options",
            "c-parse",
            "insn-attrtab",
            "insn-emit",
            "insn-modes",
            "insn-extract",
            "insn-opinit",
            "insn-output",
            "insn-peep",
            "insn-recog",
            "insn-preds",
        ]] + [
            ("i386", ":gcc-source[gcc/config/i386/i386.c]"),
            ("host-linux", ":gcc-source[gcc/config/host-linux.c]"),
            ("gtype-desc", ":gtype-output[gtype-desc.c]"),
            ("c-parse", ":frontend-generated[c-parse.c]"),
            ("options", ":options.c"),
        ] + [(
            name,
            ":machine-generated[" + name + ".c]",
        ) for name in [
            "genrtl",
            "insn-attrtab",
            "insn-emit",
            "insn-modes",
            "insn-extract",
            "insn-opinit",
            "insn-output",
            "insn-peep",
            "insn-recog",
            "insn-preds",
        ]],
    )
]

c_library(
    name = "libbackend.a",
    objects = [":cc-" + name + ".o" for name in BACKEND_OBJECTS],
    output = "libbackend.a",
    toolchain = PREDECESSOR,
)

c_binary(
    name = "cc1",
    libraries = [
        ":libbackend.a",
        ":libcpp.a",
        ":libiberty.a",
    ] + LIBC,
    objects = CRT + [":cc-" + name + ".o" for name in C_OBJECTS + ["main"]] + CRTN,
    output = "cc1",
    toolchain = PREDECESSOR,
)

generate(
    name = "i386.c",
    args = [
        "$(location :i386-declaration.c)",
        "$(location cellar//bootstrap/stage1/gcc40:patches/attribute-definition.before)",
        "$(location cellar//bootstrap/stage1/gcc40:patches/attribute-definition.after)",
    ],
    tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
)

[
    [
        generate(
            name = "cc1-" + name + "-" + opt + ".s",
            args = [
                "-quiet",
                "-nostdinc",
                "-isystem",
                "$(location " + MUSL + ":headers)",
                "-" + opt,
                "-fno-common",
                "-fno-builtin",
                "-frandom-seed=bootstrap",
                "$(location " + src + ")",
                "-o",
            ],
            output = "program.s",
            tool = ":cc1",
        ),
        generate(
            name = "cc1-" + name + "-" + opt + "-asm",
            args = [
                "--64",
                "$(location :cc1-" + name + "-" + opt + ".s)",
                "-o",
            ],
            output = "program.o",
            tool = "cellar//bootstrap/stage1/binutils:as",
        ),
        bootstrap_artifact(
            name = "cc1-" + name + "-" + opt + ".o",
            src = ":cc1-" + name + "-" + opt + "-asm",
            abi = "x86_64-sysv",
            kind = "object",
            object_format = "elf64-x86-64",
        ),
        c_binary(
            name = "cc1-" + name + "-" + opt + "-bin",
            libraries = LIBC,
            objects = CRT + [":cc1-" + name + "-" + opt + ".o"] + CRTN,
            toolchain = PREDECESSOR,
        ),
        command_test(
            name = "cc1-" + name + "-" + opt,
            args = [
                "startup",
                "ok",
            ] if name == "runtime" else [],
            env = {"BOOTSTRAP_TEST": "present"},
            tool = ":cc1-" + name + "-" + opt + "-bin",
        ),
    ]
    for opt in [
        "O0",
        "O2",
    ]
    for name, src in [
        ("c-language", "cellar//bootstrap/stage1/gcc40:tests/c-language.c"),
        (
            "runtime",
            "cellar//bootstrap/stage1/musl:test-source[tests/runtime.c]",
        ),
        (
            "threads",
            "cellar//bootstrap/stage1/musl:test-source[tests/threads.c]",
        ),
        (
            "native-math",
            "cellar//bootstrap/stage1/musl:test-source[tests/native-math.c]",
        ),
        (
            "unicode",
            "cellar//bootstrap/stage1/musl:test-source[tests/unicode.c]",
        ),
    ]
]

write_file(
    name = "invalid.c",
    content = "int main(void) { return undeclared; }\n",
)

command_test(
    name = "cc1-diagnostic",
    args = [
        "1",
        "$(location :cc1)",
        "-quiet",
        "$(location :invalid.c)",
        "-o",
        "/dev/null",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

command_test(
    name = "cc1-missing-header",
    args = [
        "1",
        "$(location :cc1)",
        "-quiet",
        "-nostdinc",
        "$(location cellar//bootstrap/stage1/gcc40:tests/c-language.c)",
        "-o",
        "/dev/null",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

[
    generate(
        name = name,
        args = [
            "$(location :gcc-4.0.4[gcc/" + name + "])",
            "$(location cellar//bootstrap/stage1/gcc40:patches/" + patch + ".before)",
            "$(location cellar//bootstrap/stage1/gcc40:patches/" + patch + ".after)",
        ],
        tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
    )
    for name, patch in [
        ("sched-int.h", "inline"),
        ("ggc-page.c", "scale"),
    ]
]

# The native bootstrap driver has one static ABI and no host search prefixes.
# These are reviewed configuration values, not imported generated headers.
write_file(
    name = "driver-configargs.h",
    content = "static const char configuration_arguments[] = \"cellar Buck2 native x86_64, C, static, no multilib\";\nstatic const char thread_model[] = \"posix\";\nstatic const struct { const char *name, *value; } configure_default_options[] = {{0, 0}};\n",
)

write_file(
    name = "multilib.h",
    content = "static const char *const multilib_raw[] = {\". ;\", 0};\nstatic const char *const multilib_matches_raw[] = {0};\nstatic const char *const multilib_exclusions_raw[] = {0};\nstatic const char *multilib_extra = \"\";\nstatic const char *multilib_options = \"\";\n#define DISABLE_MULTILIB 1\n",
)

write_file(
    name = "specs.h",
    content = "/* The C driver has no additional language specs. */\n",
)

write_file(
    name = "driver-tm.h",
    content = "\n".join(['#include \"config/' + path + '\"' for path in TARGET_HEADERS]) + '\n#include \"defaults.h\"\n' + "\n".join([
        "#undef LINK_SPEC",
        '#define LINK_SPEC \"-m elf_x86_64 -static %{m32:%eOnly native x86_64 is supported} %{shared|pie:%eOnly static executables are supported}\"',
        "#undef STARTFILE_SPEC",
        '#define STARTFILE_SPEC \"crt1.o%s crti.o%s crtbeginT.o%s\"',
        "#undef ENDFILE_SPEC",
        '#define ENDFILE_SPEC \"crtend.o%s crtn.o%s\"',
        "#undef LIB_SPEC",
        '#define LIB_SPEC \"-lc\"',
        "#undef LINK_GCC_C_SEQUENCE_SPEC",
        '#define LINK_GCC_C_SEQUENCE_SPEC \"--start-group %G %L --end-group\"',
        "#undef LINK_EH_SPEC",
        '#define LINK_EH_SPEC \"\"',
    ]) + "\n",
)

[
    generate(
        name = name,
        args = [
            "$(location " + source + ")",
            "$(location cellar//bootstrap/stage1/gcc40:patches/" + name + ".before)",
            "$(location cellar//bootstrap/stage1/gcc40:patches/" + name + ".after)",
        ],
        tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
    )
    for name, source in [
        ("driver-prefixes", ":gcc-4.0.4[gcc/gcc.c]"),
        ("driver-tool", ":driver-prefixes"),
        ("driver-pipe", ":driver-tool"),
    ]
]

filegroup(
    name = "driver-source",
    srcs = {name + ".c": ":gcc-4.0.4[gcc/" + name + ".c]" for name in [
        "gccspec",
        "cppspec",
        "prefix",
    ]} | {
        "gcc.c": ":driver-pipe",
        "tm.h": ":driver-tm.h",
        "multilib.h": ":multilib.h",
        "specs.h": ":specs.h",
        "configargs.h": ":driver-configargs.h",
    },
)

DRIVER_DEFINES = COMPILER_DEFINES + [
    'STANDARD_STARTFILE_PREFIX=\"/lib/\"',
    'STANDARD_STARTFILE_PREFIX_1=\"\"',
    'STANDARD_STARTFILE_PREFIX_2=\"\"',
    'STANDARD_EXEC_PREFIX=\"/nonexistent-bootstrap-gcc/lib/gcc/\"',
    'STANDARD_LIBEXEC_PREFIX=\"/nonexistent-bootstrap-gcc/libexec/gcc/\"',
    'STANDARD_BINDIR_PREFIX=\"/nonexistent-bootstrap-gcc/bin/\"',
    'TOOLDIR_BASE_PREFIX=\"/nonexistent-bootstrap-gcc/\"',
    'DEFAULT_TARGET_VERSION=\"4.0.4\"',
    'DEFAULT_TARGET_MACHINE=\"x86_64-cellar-linux-musl\"',
]

[
    c_object(
        name = "driver-" + name + ".o",
        src = ":driver-source[" + name + ".c]",
        defines = DRIVER_DEFINES,
        flags = [
            "-O2",
            "-Werror",
        ],
        headers = COMPILER_HEADERS + [":driver-source"],
        includes = [":driver-source"] + COMPILER_INCLUDES,
        toolchain = PREDECESSOR,
    )
    for name in [
        "gcc",
        "gccspec",
        "cppspec",
        "prefix",
    ]
]

[
    c_binary(
        name = name,
        libraries = [":libiberty.a"] + LIBC,
        objects = CRT + [
            ":driver-gcc.o",
            ":driver-" + spec + ".o",
            ":driver-prefix.o",
            ":cc-version.o",
            ":cc-intl.o",
        ] + CRTN,
        output = name,
        toolchain = PREDECESSOR,
    )
    for name, spec in [
        ("xgcc", "gccspec"),
        ("cpp-driver", "cppspec"),
    ]
]

filegroup(
    name = "native-tools",
    srcs = {
        "cc1": ":cc1",
        "as": "cellar//bootstrap/stage1/binutils:as",
        "ld": "cellar//bootstrap/stage1/binutils:ld",
    },
)

filegroup(
    name = "compiler-headers",
    srcs = {name: ":gcc-4.0.4[gcc/ginclude/" + name + "]" for name in [
        "float.h",
        "iso646.h",
        "stdarg.h",
        "stdbool.h",
        "stddef.h",
        "varargs.h",
    ]},
)

# Used to produce target runtime objects before libgcc itself exists.
configured_tool(
    name = "bootstrap-driver",
    args = [
        "-B$(location :native-tools)/",
        "-B$(location " + MUSL + ":runtime)/lib/",
        "-nostdinc",
        "-isystem",
        "$(location :compiler-headers)",
        "-isystem",
        "$(location " + MUSL + ":headers)",
    ],
    env = {"TMPDIR": "."},
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = ":xgcc",
)

compiler(
    name = "bootstrap-gcc",
    abi = "x86_64-sysv",
    archive_flags = ["crsD"],
    archive_format = "ar",
    archiver = "cellar//bootstrap/stage1/binutils:ar",
    cflags = [
        "-frandom-seed=bootstrap",
        "-g0",
    ],
    compiler = ":bootstrap-driver",
    execution_runtime = MUSL + ":runtime",
    family = "gcc",
    ldflags = ["-static"],
    linker = "cellar//bootstrap/stage1/binutils:ld",
    object_format = "elf64-x86-64",
    stage = "gcc-4.0.4-musl-rebuilt",
    sysroot = MUSL + ":runtime",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
)

[
    c_object(
        name = "driver-test-" + name + ".o",
        src = "cellar//bootstrap/stage1/gcc40:tests/c-language.c",
        flags = flags,
        object_name = "sample.o",
        toolchain = ":bootstrap-gcc",
    )
    for name, flags in [
        (
            "normal",
            ["-O2"],
        ),
        (
            "pipe",
            [
                "-O2",
                "-pipe",
            ],
        ),
    ]
]

[
    c_binary(
        name = "driver-test-" + name,
        libraries = LIBC,
        objects = CRT + [":driver-test-" + name + ".o"] + CRTN,
        toolchain = PREDECESSOR,
    )
    for name in [
        "normal",
        "pipe",
    ]
]

[command_test(
    name = "driver-compile-" + name,
    tool = ":driver-test-" + name,
) for name in [
    "normal",
    "pipe",
]]

write_file(
    name = "tiny.c",
    content = "int main(void) { return 0; }\n",
)

filegroup(
    name = "no-assembler",
    srcs = {"cc1": ":cc1"},
)

command_test(
    name = "driver-missing-assembler",
    args = [
        "1",
        "$(location :xgcc)",
        "-B$(location :no-assembler)/",
        "-pipe",
        "-c",
        "$(location :tiny.c)",
        "-o",
        "/dev/null",
    ],
    env = {
        "PATH": "/usr/bin:/bin",
        "TMPDIR": ".",
    },
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

command_test(
    name = "driver-missing-cc1",
    args = [
        "1",
        "$(location :xgcc)",
        "-fsyntax-only",
        "$(location :tiny.c)",
    ],
    env = {"PATH": "/usr/bin:/bin"},
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

write_file(
    name = "cpp-driver-input.c",
    content = "#define TWICE(x) ((x)+(x))\nTWICE(21)\n",
)

write_file(
    name = "cpp-driver-expected.txt",
    content = "\n\n\n((21)+(21))\n",
)

generate(
    name = "cpp-driver-output.txt",
    args = [
        "-B$(location :native-tools)/",
        "-nostdinc",
        "-P",
        "$(location :cpp-driver-input.c)",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = ":cpp-driver",
)

command_test(
    name = "cpp-preprocessing",
    args = [
        "$(location :cpp-driver-output.txt)",
        "$(location :cpp-driver-expected.txt)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

# Runtime sources are compiled by the newly built GCC, with native POSIX
# threads. Static musl provides these functions in libc, so use strong refs.
write_file(
    name = "tconfig.h",
    content = '#ifndef GCC40_TCONFIG_H\n#define GCC40_TCONFIG_H 1\n#define USED_FOR_TARGET 1\n#define DEFAULT_USE_CXA_ATEXIT 1\n#ifdef IN_GCC\n#include "ansidecl.h"\n#endif\n#endif\n',
)

generate(
    name = "linux-unwind.h",
    args = [
        "$(location :gcc-4.0.4[gcc/config/i386/linux-unwind.h])",
        "$(location cellar//bootstrap/stage1/gcc40:patches/unwind-context.before)",
        "$(location cellar//bootstrap/stage1/gcc40:patches/unwind-context.after)",
    ],
    tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
)

filegroup(
    name = "runtime-source",
    srcs = {name: ":gcc-4.0.4[gcc/" + name + "]" for name in [
        "libgcc2.c",
        "crtstuff.c",
        "libgcov.c",
        "unwind.inc",
        "unwind-dw2.c",
        "unwind-dw2-fde.c",
        "unwind-sjlj.c",
        "gthr-gnat.c",
        "unwind-c.c",
    ]} | {
        "config/i386/linux-unwind.h": ":linux-unwind.h",
        "tconfig.h": ":tconfig.h",
        "gthr-default.h": ":gcc-source[gcc/gthr-posix.h]",
    },
)

LIBGCC_FUNCTIONS = [
    "_muldi3",
    "_negdi2",
    "_lshrdi3",
    "_ashldi3",
    "_ashrdi3",
    "_cmpdi2",
    "_ucmpdi2",
    "_floatdidf",
    "_floatdisf",
    "_fixunsdfsi",
    "_fixunssfsi",
    "_fixunsdfdi",
    "_fixdfdi",
    "_fixunssfdi",
    "_fixsfdi",
    "_fixxfdi",
    "_fixunsxfdi",
    "_floatdixf",
    "_fixunsxfsi",
    "_fixtfdi",
    "_fixunstfdi",
    "_floatditf",
    "_clear_cache",
    "_enable_execute_stack",
    "_trampoline",
    "__main",
    "_absvsi2",
    "_absvdi2",
    "_addvsi3",
    "_addvdi3",
    "_subvsi3",
    "_subvdi3",
    "_mulvsi3",
    "_mulvdi3",
    "_negvsi2",
    "_negvdi2",
    "_ctors",
    "_ffssi2",
    "_ffsdi2",
    "_clz",
    "_clzsi2",
    "_clzdi2",
    "_ctzsi2",
    "_ctzdi2",
    "_popcount_tab",
    "_popcountsi2",
    "_popcountdi2",
    "_paritysi2",
    "_paritydi2",
    "_powisf2",
    "_powidf2",
    "_powixf2",
    "_powitf2",
    "_mulsc3",
    "_muldc3",
    "_mulxc3",
    "_multc3",
    "_divsc3",
    "_divdc3",
    "_divxc3",
    "_divtc3",
    "_eprintf",
    "__gcc_bcmp",
]

LIBGCC_DIVMOD = [
    "_divdi3",
    "_moddi3",
    "_udivdi3",
    "_umoddi3",
    "_udiv_w_sdiv",
    "_udivmoddi4",
]

LIBGCOV_FUNCTIONS = [
    "_gcov",
    "_gcov_merge_add",
    "_gcov_merge_single",
    "_gcov_merge_delta",
    "_gcov_fork",
    "_gcov_execl",
    "_gcov_execlp",
    "_gcov_execle",
    "_gcov_execv",
    "_gcov_execvp",
    "_gcov_execve",
]

UNWIND_SOURCES = [
    "unwind-dw2",
    "unwind-dw2-fde",
    "unwind-sjlj",
    "gthr-gnat",
    "unwind-c",
]

RUNTIME_DEFINES = [
    "IN_GCC=1",
    "IN_LIBGCC2=1",
    "__GCC_FLOAT_NOT_NEEDED=1",
    "HAVE_GTHR_DEFAULT=1",
    "GTHREAD_USE_WEAK=0",
]

RUNTIME_HEADERS = [
    ":runtime-source",
    ":gcc-source",
    ":frontend-generated",
    MUSL + ":headers",
]

RUNTIME_INCLUDES = [
    ":runtime-source",
    ":gcc-source[gcc]",
    ":gcc-source[include]",
    ":frontend-generated",
]

[
    c_object(
        name = "libgcc" + name + ".o",
        src = ":runtime-source[libgcc2.c]",
        defines = RUNTIME_DEFINES + ["L" + name],
        flags = [
            "-O2",
            "-fPIC",
            "-Werror",
        ] + ([
            "-fexceptions",
            "-fnon-call-exceptions",
        ] if name in LIBGCC_DIVMOD else []),
        headers = RUNTIME_HEADERS,
        includes = RUNTIME_INCLUDES,
        object_name = "g{}.o".format(i),
        toolchain = ":bootstrap-gcc",
    )
    for i, name in enumerate(LIBGCC_FUNCTIONS + LIBGCC_DIVMOD)
]

[
    c_object(
        name = name + ".o",
        src = ":runtime-source[" + name + ".c]",
        defines = RUNTIME_DEFINES,
        flags = [
            "-O2",
            "-fPIC",
            "-Werror",
        ],
        headers = RUNTIME_HEADERS,
        includes = RUNTIME_INCLUDES,
        object_name = "eh{}.o".format(i),
        toolchain = ":bootstrap-gcc",
    )
    for i, name in enumerate(UNWIND_SOURCES)
]

c_library(
    name = "libgcc.a",
    objects = [":libgcc" + name + ".o" for name in LIBGCC_FUNCTIONS + LIBGCC_DIVMOD] + [":" + name + ".o" for name in UNWIND_SOURCES],
    output = "libgcc.a",
    toolchain = ":bootstrap-gcc",
)

[
    c_object(
        name = "lib" + name + ".o",
        src = ":runtime-source[libgcov.c]",
        defines = RUNTIME_DEFINES + ["L" + name],
        flags = [
            "-O2",
            "-fPIC",
            "-Werror",
        ],
        headers = RUNTIME_HEADERS,
        includes = RUNTIME_INCLUDES,
        object_name = "cov{}.o".format(i),
        toolchain = ":bootstrap-gcc",
    )
    for i, name in enumerate(LIBGCOV_FUNCTIONS)
]

c_library(
    name = "libgcov.a",
    objects = [":lib" + name + ".o" for name in LIBGCOV_FUNCTIONS],
    output = "libgcov.a",
    toolchain = ":bootstrap-gcc",
)

[
    c_object(
        name = name,
        src = ":runtime-source[crtstuff.c]",
        defines = ["IN_GCC=1"] + defines,
        flags = [
            "-O2",
            "-g0",
            "-finhibit-size-directive",
            "-fno-inline-functions",
            "-fno-exceptions",
            "-fno-zero-initialized-in-bss",
            "-fno-unit-at-a-time",
            "-fno-omit-frame-pointer",
            "-fno-asynchronous-unwind-tables",
            "-Werror",
        ],
        headers = RUNTIME_HEADERS,
        includes = RUNTIME_INCLUDES,
        object_name = name,
        toolchain = ":bootstrap-gcc",
    )
    for name, defines in [
        (
            "crtbeginT.o",
            [
                "CRT_BEGIN",
                "CRTSTUFFT_O",
            ],
        ),
        (
            "crtend.o",
            ["CRT_END"],
        ),
    ]
]

sysroot(
    name = "runtime",
    abi = "x86_64-sysv",
    files = {"include": MUSL + ":headers"},
    libraries = {
        "lib/libc.a": MUSL + ":libc.a",
        "lib/libgcc.a": ":libgcc.a",
        "lib/libgcov.a": ":libgcov.a",
    } | {"lib/lib" + name + ".a": MUSL + ":lib" + name + ".a" for name in [
        "m",
        "pthread",
        "dl",
        "rt",
        "util",
        "resolv",
        "xnet",
    ]},
    object_format = "elf64-x86-64",
    objects = {
        "lib/crt1.o": MUSL + ":crt1.o",
        "lib/crti.o": MUSL + ":crti.o",
        "lib/crtn.o": MUSL + ":crtn.o",
        "lib/crtbeginT.o": ":crtbeginT.o",
        "lib/crtend.o": ":crtend.o",
    },
)

configured_tool(
    name = "gcc-command",
    args = [
        "-B$(location :native-tools)/",
        "-B$(location :runtime)/lib/",
        "-nostdinc",
        "-isystem",
        "$(location :compiler-headers)",
        "-isystem",
        "$(location :runtime[include])",
    ],
    env = {"TMPDIR": "."},
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = ":xgcc",
)

compiler(
    name = "gcc",
    abi = "x86_64-sysv",
    archive_flags = ["crsD"],
    archive_format = "ar",
    archiver = "cellar//bootstrap/stage1/binutils:ar",
    cflags = [
        "-frandom-seed=bootstrap",
        "-g0",
    ],
    compiler = ":gcc-command",
    execution_runtime = MUSL + ":runtime",
    family = "gcc",
    ldflags = ["-static"],
    linker = "cellar//bootstrap/stage1/binutils:ld",
    object_format = "elf64-x86-64",
    stage = "gcc-4.0.4-musl-rebuilt-with-native-runtime",
    sysroot = ":runtime",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
)

[
    [
        generate(
            name = "gcc-" + name + "-program",
            args = [
                "-O2",
                "-g0",
                "-frandom-seed=bootstrap",
                "-fexceptions",
                "-fno-optimize-sibling-calls",
                "-I$(location :gcc-source[gcc])",
                "$(location " + src + ")",
                "-o",
                "program",
            ],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            files = ["program"],
            tool = ":gcc",
        ),
        command_test(
            name = "gcc-" + name,
            args = [
                "0",
                "$(location :gcc-" + name + "-program[program])",
            ] + ([
                "startup",
                "ok",
            ] if name == "runtime" else []),
            env = {"BOOTSTRAP_TEST": "present"},
            tool = "cellar//bootstrap/stage1/tools:expect-exit",
        ),
    ]
    for name, src in [
        ("libgcc", "cellar//bootstrap/stage1/gcc40:tests/libgcc.c"),
        ("unwind", "cellar//bootstrap/stage1/gcc40:tests/unwind.c"),
        ("c-language", "cellar//bootstrap/stage1/gcc40:tests/c-language.c"),
        (
            "runtime",
            "cellar//bootstrap/stage1/musl:test-source[tests/runtime.c]",
        ),
        (
            "threads",
            "cellar//bootstrap/stage1/musl:test-source[tests/threads.c]",
        ),
        (
            "native-math",
            "cellar//bootstrap/stage1/musl:test-source[tests/native-math.c]",
        ),
        (
            "unicode",
            "cellar//bootstrap/stage1/musl:test-source[tests/unicode.c]",
        ),
    ]
]

[
    c_object(
        name = "separate-" + name + ".o",
        src = "cellar//bootstrap/stage1/tcc:test-source[tests/" + name + ".c]",
        flags = [
            "-O2",
            "-Werror",
        ],
        object_name = name + ".o",
        toolchain = ":gcc",
    )
    for name in [
        "features",
        "archive",
        "weak",
    ]
]

c_library(
    name = "separate.a",
    objects = [":separate-archive.o"],
    output = "sample.a",
    toolchain = ":gcc",
)

c_binary(
    name = "separate-program",
    libraries = [
        ":separate.a",
        ":libgcc.a",
        MUSL + ":libc.a",
        ":libgcc.a",
        MUSL + ":libc.a",
    ],
    objects = CRT + [
        ":separate-features.o",
        ":separate-weak.o",
    ] + CRTN,
    toolchain = ":gcc",
)

command_test(
    name = "gcc-separate-archive-weak",
    tool = ":separate-program",
)

command_test(
    name = "gcc-missing-library",
    args = [
        "1",
        "$(location :xgcc)",
        "-B$(location :native-tools)/",
        "-B$(location :runtime)/lib/",
        "-nostdlib",
        "$(location :driver-test-normal.o)",
        "-lstdc++",
        "-o",
        "/dev/null",
    ],
    env = {
        "TMPDIR": ".",
        "PATH": "/usr/bin:/bin",
    },
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

command_test(
    name = "gcc-missing-headers",
    args = [
        "1",
        "$(location :xgcc)",
        "-B$(location :native-tools)/",
        "-nostdinc",
        "-fsyntax-only",
        "$(location cellar//bootstrap/stage1/gcc40:tests/c-language.c)",
    ],
    env = {"PATH": "/usr/bin:/bin"},
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

configured_tool(
    name = "cpp",
    args = [
        "-B$(location :native-tools)/",
        "-nostdinc",
        "-isystem",
        "$(location :compiler-headers)",
        "-isystem",
        "$(location :runtime[include])",
    ],
    env = {"TMPDIR": "."},
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = ":cpp-driver",
)

filegroup(
    name = "installation",
    srcs = {
        "bin/gcc": ":xgcc",
        "bin/cpp": ":cpp-driver",
        "libexec/gcc/cc1": ":cc1",
        "libexec/gcc/as": "cellar//bootstrap/stage1/binutils:as",
        "libexec/gcc/ld": "cellar//bootstrap/stage1/binutils:ld",
        "lib/gcc/include": ":compiler-headers",
        "sysroot": ":runtime",
        "share/licenses/gcc/COPYING": ":gcc-4.0.4[COPYING]",
        "share/licenses/gcc/COPYING.LIB": ":gcc-4.0.4[COPYING.LIB]",
    },
)
