# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Chez Scheme's boot-file build (s/build.zuo), as Buck2 actions.

A Scheme that runs on the build machine compiles Chez Scheme's own sources
into the boot files for a machine type, and generates the C headers that the
kernel for that machine type is compiled against. Each step is one action:
the files that set up the compiler (`cmacros.so` and friends), the Nanopass
framework, the cross-compilation patches, the boot files, and the headers.
"""

load("@root//buck/shims:shims.bzl", "shims")

# The sources of petite.boot, in order. Upstream's `base-src-names`.
BASE_SRCS = [
    "library",
    "prims",
    "mathprims",
    "record",
    "5_1",
    "5_2",
    "5_3",
    "strnum",
    "bytevector",
    "5_4",
    "5_6",
    "5_7",
    "event",
    "4",
    "front",
    "foreign",
    "6",
    "print",
    "newhash",
    "format",
    "date",
    "7",
    "cafe",
    "trace",
    "engine",
    "interpret",
    "cprep",
    "cpcheck",
    "cp0",
    "cpvalid",
    "cptypes",
    "cpcommonize",
    "cpletrec",
    "inspect",
    "enum",
    "io",
    "read",
    "primvars",
    "syntax",
    "costctr",
    "expeditor",
    "exceptions",
    "pretty",
    "env",
    "fasl",
    "vfasl",
    "pbchunk",
    "reloc",
    "pdhtml",
    "strip",
    "ftype",
    "back",
]

# The sources of scheme.boot, the compiler. Upstream's `compiler-names`.
COMPILER_SRCS = [
    "cpnanopass",
    "cpprim",
    "compile",
    "cback",
]

# The parts of the compiler that a cross-compiling host recompiles for
# itself, so that it generates code for the target. Upstream's `patch-names`,
# in the order they're concatenated into `xpatch`.
PATCHES = [
    "patch",
    "cpnanopass",
    "cpprim",
    "cprep",
    "cpcheck",
    "cp0",
    "cpvalid",
    "cptypes",
    "cpcommonize",
    "cpletrec",
    "reloc",
    "compile",
    "fasl",
    "vfasl",
    "pbchunk",
    "syntax",
    "env",
    "read",
    "interpret",
    "ftype",
    "strip",
    "ubify",
    "back",
]

# The files that set up the compiler, each loading the ones before it:
# `(name, loads)`. Upstream's `compilation-preamble-target`s.
_PREAMBLE = [
    ("cmacros", []),
    ("priminfo", ["cmacros"]),
    ("primvars", ["cmacros", "priminfo"]),
    ("env", ["cmacros", "priminfo"]),
    ("setup", ["cmacros", "priminfo"]),
    ("mkheader", ["cmacros", "priminfo", "primvars", "env"]),
    ("mkgc", ["cmacros", "priminfo", "primvars", "env", "mkheader"]),
]

# What every compilation loads first. Upstream's `macro-objs`.
_MACROS = ["cmacros", "priminfo", "primvars", "env", "setup"]

# The C headers, and the call (to mkheader.so or mkgc.so) that writes each,
# with `m` the machine type.
HEADERS = {
    "equates.h": "(mkequates.h \"equates.h\")",
    "gc-ocd.inc": "(mkgc-ocd.inc \"gc-ocd.inc\")",
    "gc-oce.inc": "(mkgc-oce.inc \"gc-oce.inc\")",
    "gc-par.inc": "(mkgc-par.inc \"gc-par.inc\")",
    "heapcheck.inc": "(mkheapcheck.inc \"heapcheck.inc\")",
    "scheme.h": "(mkscheme.h \"scheme.h\" m)",
}

# Upstream's defaults: optimize-level 3, no inspector information, and
# compressed fasl data. Upstream runs with absolute paths and the default
# timestamp mode; here the paths are relative to the action's directory, and
# libraries are taken from their object files whatever the files' times are,
# since Buck2 doesn't keep them in order.
_COMPILER_PARAMETERS = """
(reset-handler abort)
(base-exception-handler (lambda (c) (fresh-line) (display-condition c) (newline) (reset)))
(optimize-level 3)
(debug-level 0)
(fasl-compressed #t)
(generate-inspector-information #f)
(library-timestamp-mode 'exists)
"""

_CP0_AND_GC = """
(run-cp0 (lambda (cp0 x) (do ([i 2 (fx- i 1)] [x x (cp0 x)]) ((fx= i 0) x))))
(collect-trip-bytes (expt 2 24))
(unless (eq? 'pb (machine-type))
  (collect-request-handler (lambda () (collect 0 1)))
  (collect 1 2))
"""

def _scheme_step(
        name: str,
        host: str,
        loads: list[str],
        inputs: list[str],
        script: str,
        out: str | None = None,
        outs: dict[str, list[str]] | None = None,
        args: list[str] = [],
        env: dict = {}):
    """Run the host Scheme on `script` in a scratch directory.

    The directory holds `src`, the source tree, and a copy of each of
    `inputs`; `loads` are loaded before the script, which writes the outputs
    there.
    """
    if out:
        outputs = {"out": out}
        collect = ["cp {} $root/$OUT".format(out)]
    else:
        outputs = {"outs": outs}
        collect = ["mkdir -p $root/$OUT"] + [
            "cp -R {} $root/$OUT/".format(paths[0])
            for paths in outs.values()
        ]
    shims.genrule(
        name = name,
        cmd = "\n".join([
            "set -eu",
            "root=$PWD",
            "mkdir $TMP/work",
            "cd $TMP/work",
            "ln -s $root/$(location :src) src",
        ] + [
            "cp -R $root/$(location {}) .".format(i)
            for i in inputs
        ] + [
            "{host} {args} -q {loads} <<'EOF'".format(
                host = host,
                args = " ".join(args),
                loads = " ".join(loads),
            ),
            "(source-directories '(\".\" \"src/s\" \"src/unicode\"))",
            "(library-directories '((\"src/nanopass\" . \".\") (\"src/s\" . \".\")))",
            script.strip(),
            "EOF",
        ] + collect),
        env = env,
        visibility = [],
        **outputs
    )

def chez_boot_files(
        name: str,
        host: str,
        machine,
        cross: bool):
    """Compile the boot files and headers for `machine` with `host`.

    Creates `:<name>` with the boot files, `petite.boot` and `scheme.boot`,
    and `:<name>-headers` with the headers, both by name.

    Args:
        name: the prefix of the targets.
        host: the command that runs the host Scheme, Buck2 macros and all,
            relative to the root of the build.
        machine: the machine type to compile for, a string or a select.
        cross: whether the host is another machine type, which then loads
            the compiler patched to generate code for `machine`.
    """
    host = "$root/" + host

    def target(step):
        return ":{}-{}".format(name, step)

    shims.genrule(
        name = name + "-machine.def",
        out = "machine.def",
        # `[$]`, since Buck2 would take `$(M)` for a macro.
        cmd = "sed -e 's/[$](M)/'$MACHINE/ -e 's/[$](March)/'$ARCH/ $(location :src)/s/tunix.def > $OUT",
        env = {
            "ARCH": shims.select({
                "config//cpu:arm64": "arm64",
                "config//cpu:x86_64": "a6",
            }),
            "MACHINE": machine,
        },
        visibility = [],
    )

    for step, loads in _PREAMBLE:
        _scheme_step(
            name = "{}-{}.so".format(name, step),
            host = host,
            loads = [dep + ".so" for dep in loads],
            inputs = [target(dep + ".so") for dep in loads] + (
                [target("machine.def")] if step == "cmacros" else []
            ),
            script = _COMPILER_PARAMETERS + """
                (subset-mode 'system)
                (compile-file "src/s/{step}.ss" "{step}.so")
            """.format(step = step),
            out = step + ".so",
        )

    # The library, and the libraries it imports, compiled into `nanopass/`.
    _scheme_step(
        name = name + "-nanopass",
        host = host,
        loads = [],
        inputs = [],
        args = ["--compile-imported-libraries"],
        script = _COMPILER_PARAMETERS + """
            (compile-library "src/nanopass/nanopass.ss" "nanopass.so")
        """,
        outs = {
            "dir": ["nanopass"],
            "nanopass.so": ["nanopass.so"],
        },
    )

    macros = [m + ".so" for m in _MACROS]
    compiler_inputs = [target(m) for m in macros] + [
        target("nanopass[dir]"),
        target("nanopass[nanopass.so]"),
    ]

    if cross:
        for patch in PATCHES:
            _scheme_step(
                name = "{}-{}.patch".format(name, patch),
                host = host,
                loads = macros,
                inputs = compiler_inputs,
                script = _COMPILER_PARAMETERS + _CP0_AND_GC + """
                    (compile-file "src/s/{patch}.ss" "{patch}.patch")
                """.format(patch = patch),
                out = patch + ".patch",
            )

        shims.genrule(
            name = name + "-xpatch",
            out = "xpatch",
            cmd = "cat {} > $OUT".format(" ".join([
                "$(location {})".format(target(patch + ".patch"))
                for patch in PATCHES
            ])),
            visibility = [],
        )

    # Upstream's `bootall`: everything in one session, then the boot files.
    # The machine type is a select, so the script takes it from the
    # environment. (A top-level `define` would be a new variable in the
    # system environment these sessions run in.)
    objs = BASE_SRCS + COMPILER_SRCS
    _scheme_step(
        name = name,
        host = host,
        loads = macros + (["xpatch"] if cross else []),
        inputs = compiler_inputs + ([target("xpatch")] if cross else []),
        script = _COMPILER_PARAMETERS + _CP0_AND_GC + """
            (let* ([m (string->symbol (getenv "MACHINE"))]
                   [obj (lambda (src) (format "~a.~a" src m))])
              (time (for-each (lambda (src)
                                (collect 1 2)
                                (compile-file (format "src/s/~a.ss" src) (obj src) m))
                              '({objs})))
              (printf "    ~a bytes peak memory use~n" (maximum-memory-bytes))
              (#%$make-boot-file "petite.boot" m '() {base})
              (#%$make-boot-file "scheme.boot" m '("petite") {compiler}))
        """.format(
            base = " ".join(["(obj \"{}\")".format(s) for s in BASE_SRCS]),
            compiler = " ".join(["(obj \"{}\")".format(s) for s in COMPILER_SRCS]),
            objs = " ".join(["\"{}\"".format(s) for s in objs]),
        ),
        outs = {
            "petite.boot": ["petite.boot"],
            "scheme.boot": ["scheme.boot"],
        },
        env = {"MACHINE": machine},
    )

    # Written by the host's compiler from the target's cmacros.so, without
    # the patches.
    _scheme_step(
        name = name + "-headers",
        host = host,
        loads = macros + ["mkheader.so", "mkgc.so"],
        inputs = [target(m) for m in macros + ["mkheader.so", "mkgc.so"]],
        script = """
            (reset-handler abort)
            (let ([m (string->symbol (getenv "MACHINE"))])
        """ + "\n".join(HEADERS.values()) + ")",
        outs = {h: [h] for h in HEADERS},
        env = {"MACHINE": machine},
    )
