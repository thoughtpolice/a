# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Chez Scheme's boot-file build (s/build.zuo), as Buck2 actions.

A Scheme that runs on the build machine compiles Chez Scheme's own sources
into the boot files for a machine type, and generates the C headers that the
kernel for that machine type is compiled against. Each step is one action:
the machine's definitions, the files that set up the compiler (`cmacros.so`
and friends), the Nanopass framework, the cross-compilation patches, the
boot files, and the headers.

Every step runs the host Scheme itself, with no shell, so that the build
works the same on Linux, macOS and Windows; see `_chez_step`.
"""

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
# with `m` the machine type and `out` naming a file in the step's outputs.
HEADERS = {
    "equates.h": "(mkequates.h (out \"equates.h\"))",
    "gc-ocd.inc": "(mkgc-ocd.inc (out \"gc-ocd.inc\"))",
    "gc-oce.inc": "(mkgc-oce.inc (out \"gc-oce.inc\"))",
    "gc-par.inc": "(mkgc-par.inc (out \"gc-par.inc\"))",
    "heapcheck.inc": "(mkheapcheck.inc (out \"heapcheck.inc\"))",
    "scheme.h": "(mkscheme.h (out \"scheme.h\") m)",
}

# Upstream's defaults: optimize-level 3, no inspector information, and
# compressed fasl data. Upstream runs with absolute paths and the default
# timestamp mode; here the paths are relative to the step's directory, and
# libraries are taken from their object files whatever the files' times are,
# since Buck2 doesn't keep them in order.
_COMPILER_PARAMETERS = """
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

# MARK: Steps

# What every step's script starts with. A step runs, from the root of the
# build, as
#
#   HOST -q --script step.ss WORK OUT
#
# where WORK holds `src`, the source tree, and the step's inputs by name, and
# OUT is the directory its outputs go in. The script makes OUT, then works in
# WORK, so that the paths the compiler sees (and may record) are the same
# relative ones on every machine and in every checkout; outputs are written
# through $OUT, made absolute first. Errors exit nonzero. (A top-level
# `define` would be a new variable in the system environment these sessions
# run in, so there are none.)
_PROLOGUE = """
(reset-handler abort)
(base-exception-handler (lambda (c) (fresh-line) (display-condition c) (newline) (reset)))
(let ([args (command-line-arguments)]
      [cwd (current-directory)])
  (define (absolute path)
    (if (path-absolute? path) path (string-append cwd "/" path)))
  (putenv "OUT" (absolute (cadr args)))
  (mkdir (getenv "OUT"))
  (current-directory (car args)))
"""

def _scheme_string(s: str) -> str:
    return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

def _chez_step_impl(ctx: AnalysisContext) -> list[Provider]:
    out = ctx.actions.declare_output("out", dir = True)
    work = ctx.actions.symlinked_dir("work", {"src": ctx.attrs.src} | ctx.attrs.inputs)

    # The machine type and architecture may come from a select, so they go
    # into the script here, as Scheme strings.
    body = ctx.attrs.script.strip()
    body = body.replace("@MACHINE@", _scheme_string(ctx.attrs.machine))
    body = body.replace("@ARCH@", _scheme_string(ctx.attrs.arch))
    script = ctx.actions.write("step.ss", "\n".join([
        _PROLOGUE.strip(),
    ] + [
        "(load {})".format(_scheme_string(f))
        for f in ctx.attrs.loads
    ] + [
        "(source-directories '(\".\" \"src/s\" \"src/unicode\"))",
        "(library-directories '((\"src/nanopass\" . \".\") (\"src/s\" . \".\")))",
        body,
        "",
    ]))
    ctx.actions.run(
        cmd_args(ctx.attrs.host, "-q", "--script", script, work, out.as_output()),
        category = "chez_bootstrap",
    )
    return [DefaultInfo(
        default_output = out,
        sub_targets = {
            name: [DefaultInfo(default_output = out.project(name))]
            for name in ctx.attrs.outs
        },
    )]

# One step of the build: the host Scheme, run on `script`.
_chez_step = rule(
    impl = _chez_step_impl,
    attrs = {
        "arch": attrs.string(default = ""),
        # The command that runs the host Scheme, one argument each.
        "host": attrs.list(attrs.arg()),
        # The step's inputs, by their names in its directory.
        "inputs": attrs.dict(attrs.string(), attrs.source(allow_directory = True), default = {}),
        # Loaded, from the step's directory, before the script.
        "loads": attrs.list(attrs.string(), default = []),
        "machine": attrs.string(default = ""),
        # What the step writes in $OUT, each a sub-target by its name.
        "outs": attrs.list(attrs.string()),
        # Scheme, in which @MACHINE@ and @ARCH@ are those strings.
        "script": attrs.string(),
        "src": attrs.source(allow_directory = True),
    },
)

# Upstream's `machine.def` (s/machine.zuo): the machine's own .def file where
# Chez Scheme has one (as for Windows: ta6nt.def), and otherwise tunix.def
# (unix.def, unthreaded) with the machine type and architecture filled in.
_MACHINE_DEF = """
(let* ([m @MACHINE@]
       [own (format "src/s/~a.def" m)]
       [read-all (lambda (path) (call-with-port (open-file-input-port path) get-bytevector-all))]
       [fill (lambda (template)
               (let loop ([i 0] [acc '()])
                 (define (at? key)
                   (let ([j (+ i (string-length key))])
                     (and (<= j (string-length template))
                          (string=? (substring template i j) key))))
                 (cond
                  [(= i (string-length template)) (apply string-append (reverse acc))]
                  [(at? "$(March)") (loop (+ i 8) (cons @ARCH@ acc))]
                  [(at? "$(M)") (loop (+ i 4) (cons m acc))]
                  [else (loop (+ i 1) (cons (string (string-ref template i)) acc))])))])
  (call-with-port (open-file-output-port (format "~a/machine.def" (getenv "OUT")))
    (lambda (p)
      (put-bytevector
       p
       (if (file-exists? own)
           (read-all own)
           (string->utf8
            (fill (utf8->string
                   (read-all (if (char=? (string-ref m 0) #\\t)
                                 "src/s/tunix.def"
                                 "src/s/unix.def"))))))))))
"""

# Upstream's `xpatch`: the compiled patches, concatenated in order.
_XPATCH = """
(call-with-port (open-file-output-port (format "~a/xpatch" (getenv "OUT")))
  (lambda (p)
    (for-each
     (lambda (patch)
       (put-bytevector p (call-with-port (open-file-input-port patch) get-bytevector-all)))
     '({patches}))))
"""

def chez_boot_files(
        name: str,
        host: list,
        src: str,
        machine,
        arch,
        cross: bool):
    """Compile the boot files and headers for `machine` with `host`.

    Creates `:<name>` with the boot files, `[petite.boot]` and
    `[scheme.boot]`, and `:<name>-headers` with the headers, each a
    sub-target by its name.

    Args:
        name: the prefix of the targets.
        host: the command that runs the host Scheme, one argument each, with
            Buck2 macros; paths are relative to the root of the build.
        src: the source tree.
        machine: the machine type to compile for, a string or a select.
        arch: its architecture (`a6`, `arm64`), a string or a select.
        cross: whether the host is another machine type, which then loads
            the compiler patched to generate code for `machine`.
    """

    def target(step, out):
        return ":{}-{}[{}]".format(name, step, out)

    def step(step_name, **kwargs):
        _chez_step(
            name = step_name,
            host = host,
            src = src,
            visibility = [],
            **kwargs
        )

    step(
        name + "-machine.def",
        arch = arch,
        machine = machine,
        script = _MACHINE_DEF,
        outs = ["machine.def"],
    )

    for so, loads in _PREAMBLE:
        step(
            "{}-{}.so".format(name, so),
            loads = [dep + ".so" for dep in loads],
            inputs = {
                dep + ".so": target(dep + ".so", dep + ".so")
                for dep in loads
            } | ({"machine.def": target("machine.def", "machine.def")} if so == "cmacros" else {}),
            script = _COMPILER_PARAMETERS + """
                (subset-mode 'system)
                (compile-file "src/s/{so}.ss" (format "~a/{so}.so" (getenv "OUT")))
            """.format(so = so),
            outs = [so + ".so"],
        )

    # The library, and the libraries it imports, which go in $OUT/nanopass.
    step(
        name + "-nanopass",
        script = _COMPILER_PARAMETERS + """
            (compile-imported-libraries #t)
            (library-directories (list (cons "src/nanopass" (getenv "OUT"))))
            (compile-library "src/nanopass/nanopass.ss" (format "~a/nanopass.so" (getenv "OUT")))
        """,
        outs = [
            "nanopass",
            "nanopass.so",
        ],
    )

    macros = [m + ".so" for m in _MACROS]
    compiler_inputs = {m: target(m, m) for m in macros} | {
        "nanopass": target("nanopass", "nanopass"),
        "nanopass.so": target("nanopass", "nanopass.so"),
    }

    if cross:
        for patch in PATCHES:
            step(
                "{}-{}.patch".format(name, patch),
                loads = macros,
                inputs = compiler_inputs,
                script = _COMPILER_PARAMETERS + _CP0_AND_GC + """
                    (compile-file "src/s/{patch}.ss" (format "~a/{patch}.patch" (getenv "OUT")))
                """.format(patch = patch),
                outs = [patch + ".patch"],
            )

        step(
            name + "-xpatch",
            inputs = {
                patch + ".patch": target(patch + ".patch", patch + ".patch")
                for patch in PATCHES
            },
            script = _XPATCH.format(patches = " ".join([
                _scheme_string(patch + ".patch")
                for patch in PATCHES
            ])),
            outs = ["xpatch"],
        )

    # Upstream's `bootall`: everything in one session, then the boot files.
    # The objects go in $OUT/obj, removed once they are in the boot files.
    objs = BASE_SRCS + COMPILER_SRCS
    step(
        name,
        machine = machine,
        loads = macros + (["xpatch"] if cross else []),
        inputs = compiler_inputs | ({"xpatch": target("xpatch", "xpatch")} if cross else {}),
        script = _COMPILER_PARAMETERS + _CP0_AND_GC + """
            (let* ([m (string->symbol @MACHINE@)]
                   [dir (format "~a/obj" (getenv "OUT"))]
                   [obj (lambda (src) (format "~a/~a.~a" dir src m))]
                   [objs '({objs})])
              (mkdir dir)
              (time (for-each (lambda (src)
                                (collect 1 2)
                                (compile-file (format "src/s/~a.ss" src) (obj src) m))
                              objs))
              (printf "    ~a bytes peak memory use~n" (maximum-memory-bytes))
              (#%$make-boot-file (format "~a/petite.boot" (getenv "OUT")) m '() {base})
              (#%$make-boot-file (format "~a/scheme.boot" (getenv "OUT")) m '("petite") {compiler})
              (for-each (lambda (src) (delete-file (obj src))) objs)
              (delete-directory dir))
        """.format(
            base = " ".join(["(obj \"{}\")".format(s) for s in BASE_SRCS]),
            compiler = " ".join(["(obj \"{}\")".format(s) for s in COMPILER_SRCS]),
            objs = " ".join(["\"{}\"".format(s) for s in objs]),
        ),
        outs = [
            "petite.boot",
            "scheme.boot",
        ],
    )

    # Written by the host's compiler from the target's cmacros.so, without
    # the patches.
    step(
        name + "-headers",
        machine = machine,
        loads = macros + ["mkheader.so", "mkgc.so"],
        inputs = {m: target(m, m) for m in macros + ["mkheader.so", "mkgc.so"]},
        script = """
            (let ([m (string->symbol @MACHINE@)]
                  [out (lambda (h) (format "~a/~a" (getenv "OUT") h))])
        """ + "\n".join(HEADERS.values()) + ")",
        outs = list(HEADERS.keys()),
    )

# MARK: Installation

def _chez_install_impl(ctx: AnalysisContext) -> list[Provider]:
    exe = ctx.attrs.scheme[DefaultInfo].default_outputs[0]

    # Windows runs nothing without its .exe, and the executable strips it
    # from its name before choosing its boot file.
    suffix = exe.extension if exe.extension == ".exe" else ""
    lib = "lib/csv{}/{}".format(ctx.attrs.version, ctx.attrs.machine)
    paths = {
        "petite": "bin/petite" + suffix,
        "petite.boot": lib + "/petite.boot",
        "scheme": "bin/scheme" + suffix,
        "scheme-script": "bin/scheme-script" + suffix,
        "scheme-script.boot": lib + "/scheme-script.boot",
        "scheme.boot": lib + "/scheme.boot",
        "scheme.h": lib + "/scheme.h",
    }
    out = ctx.actions.copied_dir("out", {
        paths["petite"]: exe,
        paths["petite.boot"]: ctx.attrs.petite_boot,
        paths["scheme"]: exe,
        paths["scheme-script"]: exe,
        paths["scheme-script.boot"]: ctx.attrs.scheme_boot,
        paths["scheme.boot"]: ctx.attrs.scheme_boot,
        paths["scheme.h"]: ctx.attrs.scheme_h,
    })
    return [DefaultInfo(
        default_output = out,
        sub_targets = {
            name: [DefaultInfo(default_output = out.project(path))]
            for name, path in (paths | {"bin": "bin", "lib": lib}).items()
        },
    )]

# Upstream's install layout, with each file a sub-target by name (and `bin`
# and `lib`, the machine's library directory). The executable picks its boot
# file from the name it was run as, so `petite` and `scheme-script` are
# copies of it, and scheme-script.boot of scheme.boot.
chez_install = rule(
    impl = _chez_install_impl,
    attrs = {
        "machine": attrs.string(),
        "petite_boot": attrs.source(),
        "scheme": attrs.dep(),
        "scheme_boot": attrs.source(),
        "scheme_h": attrs.source(),
        "version": attrs.string(),
    },
)
