# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Lean 4 toolchain and build rules.

Lean is driven directly, one action per module, with no Lake. A library's
sources are parsed for their imports by one `lean --deps-json` action, and
a dynamic action reads that import graph (and those of the library's
dependencies) to lay out the per-module actions:

  elab   `lean --setup` produces the module's .olean files, .ilean, IR
         and C. The setup file maps every module in the import closure to
         the exact files Buck built for it, so there is no LEAN_PATH and
         no search; stdlib modules come from the toolchain's own lib/lean.
  ir     with `split_codegen`, a `module` file's elab action stops at the
         .olean files and `leanir` produces .ir.sig, .ir and the C code
         afterwards (compiler.postponeCompile). An importer that is
         itself a `module` then elaborates without waiting for its
         imports' code generation. This is experimental in Lean, and see
         `split_codegen` for where it fails.

The generated C goes to an ordinary `cxx_library` (or `cxx_binary`) built
with the C++ toolchain, which links against `toolchains//lean:runtime`.
Lean code therefore links into C++ and Rust programs, and C++ libraries
can implement `@[extern]` declarations, through plain `deps`.

`lean_library` returns the C++ library's providers along with
LeanLibraryInfo, the per-module artifacts the Lean side needs.
"""

# What `leanc --print-cflags` passes when compiling generated C, minus its
# -I flag. The toolchain check fails if the installed Lean disagrees.
LEAN_C_FLAGS = [
    "-fstack-clash-protection",
    "-ffp-contract=off",
    "-fdata-sections",
    "-ffunction-sections",
    "-fPIC",
    "-fvisibility=hidden",
]

# Generated C is compiled the way Lake compiles it on every non-Windows
# platform (LEAN_EXPORTING objects, even in executables), and its warnings
# are not ours to fix.
LEAN_C_COMPILE_FLAGS = LEAN_C_FLAGS + [
    "-DLEAN_EXPORTING",
    "-w",
]

# Root namespaces of the modules shipped in the toolchain's lib/lean. An
# import under one of these that no dependency provides is left to Lean,
# which finds it next to its own binary.
STDLIB_ROOTS = [
    "Init",
    "Lake",
    "LakeMain",
    "Lean",
    "LeanChecker",
    "LeanExport",
    "LeanIR",
    "Leanc",
    "Std",
]

RUNTIME = "toolchains//lean:runtime"

# MARK: Providers

LeanToolchainInfo = provider(
    doc = "The Lean toolchain found on PATH",
    fields = {
        # RunInfo of the action helper (tool.py)
        "tool": provider_field(typing.Any),
        # Output of the toolchain check. Every Lean action takes it as an
        # input, so a different Lean build changes every action key.
        "stamp": provider_field(typing.Any),
    },
)

LeanModule = record(
    name = field(str),
    src = field(Artifact),
    # NAME.olean, NAME.olean.server, NAME.olean.private, NAME.ilean
    elab = field(Artifact),
    # NAME.ir.sig, which is all that leanir needs from an import
    sig = field(Artifact),
    # NAME.ir, which the interpreter needs from `meta` imports and
    # non-module importers
    ir = field(Artifact),
    c = field(Artifact),
)

LeanLibraryInfo = provider(
    doc = "Lean modules and everything they import",
    fields = {
        "package": provider_field(str),
        "options": provider_field(typing.Any),
        # Names of this library's own modules
        "own": provider_field(list[str]),
        # Every module reachable through deps, this library's included,
        # keyed by module name
        "modules": provider_field(typing.Any),
        # Import graphs (JSON, written by `tool.py deps`) of this library and
        # every library reachable through deps
        "graphs": provider_field(list[Artifact]),
    },
)

# MARK: Toolchain

def _lean_toolchain_check_impl(ctx: AnalysisContext) -> list[Provider]:
    cflags = ctx.actions.declare_output("cflags.txt")
    ldflags = ctx.actions.declare_output("ldflags.txt")
    ctx.actions.run(
        cmd_args(
            ctx.attrs.tool[RunInfo],
            "toolchain",
            "--nix-expr",
            ctx.attrs.nix_expr,
            ["--expect-cflag=" + flag for flag in LEAN_C_FLAGS],
            "--cflags-out",
            cflags.as_output(),
            "--ldflags-out",
            ldflags.as_output(),
            hidden = ctx.attrs.nix_lock,
        ),
        category = "lean_toolchain",
        # The answer depends on the PATH of the machine running Buck, and
        # holds Nix store paths. Never take it from, or give it to, the
        # shared cache.
        local_only = True,
        allow_cache_upload = False,
    )
    return [
        DefaultInfo(
            default_outputs = [cflags, ldflags],
            sub_targets = {
                "cflags": [DefaultInfo(default_output = cflags)],
                "ldflags": [DefaultInfo(default_output = ldflags)],
            },
        ),
    ]

lean_toolchain_check = rule(
    impl = _lean_toolchain_check_impl,
    attrs = {
        # The Nix expression that builds the Lean in the dev shell; its
        # `version` is the one `lean --version` must report.
        "nix_expr": attrs.source(),
        "nix_lock": attrs.source(),
        "tool": attrs.exec_dep(providers = [RunInfo]),
    },
)

def _lean_toolchain_impl(ctx: AnalysisContext) -> list[Provider]:
    return [
        DefaultInfo(),
        LeanToolchainInfo(
            tool = ctx.attrs.tool[RunInfo],
            stamp = ctx.attrs.check[DefaultInfo].sub_targets["cflags"][DefaultInfo].default_outputs[0],
        ),
    ]

lean_toolchain = rule(
    impl = _lean_toolchain_impl,
    attrs = {
        "check": attrs.dep(),
        "tool": attrs.exec_dep(providers = [RunInfo]),
    },
    is_toolchain_rule = True,
)

# MARK: Modules

def module_name(src: str, root: str) -> str:
    """`Foo/Bar.lean` under `root` is module `Foo.Bar`."""
    path = src
    if root:
        prefix = root.rstrip("/") + "/"
        if not path.startswith(prefix):
            fail("source {} is not under root {}".format(src, root))
        path = path[len(prefix):]
    if not path.endswith(".lean"):
        fail("source {} does not end in .lean".format(src))
    return path[:-len(".lean")].replace("/", ".")

def _modules(srcs: list[str], root: str) -> dict[str, str]:
    modules = {}
    for src in srcs:
        name = module_name(src, root)
        if name in modules:
            fail("module {} comes from both {} and {}".format(name, modules[name], src))
        modules[name] = src
    return modules

def _is_stdlib(name: str) -> bool:
    return name.split(".")[0] in STDLIB_ROOTS

def _closure(name: str, graph: dict, modules: dict) -> list[str]:
    """Every non-stdlib module `name` imports, directly or not, sorted."""
    seen = {}
    stack = [name]
    for _ in range(len(graph) + 1):
        if not stack:
            break
        next = []
        for current in stack:
            for imp in graph[current]["imports"]:
                dep = imp["module"]
                if dep in seen or (dep not in modules and _is_stdlib(dep)):
                    continue
                if dep == name:
                    fail("module {} imports itself through {}".format(name, current))
                if dep not in modules:
                    fail("module {} imports {}, which no dependency of this target provides".format(current, dep))
                seen[dep] = True
                next.append(dep)
        stack = next
    return sorted(seen.keys())

def _import_arg(module: LeanModule, with_ir: bool, for_leanir: bool = False) -> cmd_args:
    if for_leanir:
        dirs = [module.elab, module.sig]
    elif with_ir:
        dirs = [module.elab, module.sig, module.ir]
    else:
        dirs = [module.elab]
    return cmd_args("--import=", module.name, "=", cmd_args(dirs, delimiter = ","), delimiter = "")

def _lean_modules_impl(ctx: AnalysisContext) -> list[Provider]:
    toolchain = ctx.attrs._lean_toolchain[LeanToolchainInfo]
    package = ctx.attrs.package or ctx.label.name
    options = dict(ctx.attrs.options)
    if ctx.attrs.warnings_as_errors:
        options["warningAsError"] = True
    options_json = json.encode(options)

    dep_infos = [d[LeanLibraryInfo] for d in ctx.attrs.deps if LeanLibraryInfo in d]
    modules = {}
    graphs = {}
    for info in dep_infos:
        modules.update(info.modules)
        for g in info.graphs:
            graphs[g] = True

    own = {}
    for name, src in ctx.attrs.modules.items():
        if name in modules:
            fail("module {} is also provided by a dependency".format(name))
        own[name] = LeanModule(
            name = name,
            src = src,
            elab = ctx.actions.declare_output("elab", name, dir = True),
            sig = ctx.actions.declare_output("sig", name, dir = True),
            ir = ctx.actions.declare_output("ir", name, dir = True),
            c = ctx.actions.declare_output("c", name.replace(".", "/") + ".c"),
        )
    modules.update(own)

    graph = ctx.actions.declare_output("imports.json")
    ctx.actions.run(
        cmd_args(
            toolchain.tool,
            "deps",
            "--out",
            graph.as_output(),
            [cmd_args("--module=", m.name, "=", m.src, delimiter = "") for m in own.values()],
            hidden = toolchain.stamp,
        ),
        category = "lean_deps",
    )
    dep_graphs = list(graphs.keys())
    split_codegen = ctx.attrs.split_codegen
    allow_sorry = ctx.attrs.allow_sorry
    lean_flags = ctx.attrs.lean_flags

    def compile(ctx: AnalysisContext, artifacts, outputs) -> None:
        import_graph = {}
        for g in [graph] + dep_graphs:
            import_graph.update(artifacts[g].read_json())

        for name, m in own.items():
            header = import_graph[name]
            closure = [modules[dep] for dep in _closure(name, import_graph, modules)]

            # The interpreter runs imported code for `meta` and `import all`
            # imports, and for anything a non-module file elaborates; those
            # need the IR of everything below them. So does generating code
            # in the elab action, which inlines and specializes imported
            # definitions. Only a split `module` file goes without.
            split = header["isModule"] and split_codegen
            needs_ir = not split
            for i in header["imports"]:
                if i["meta"] or i["all"]:
                    needs_ir = True

            elab = cmd_args(
                toolchain.tool,
                "elab",
                "--module",
                name,
                "--package",
                package,
                "--options",
                options_json,
                "--src",
                m.src,
                "--elab-out",
                outputs[m.elab].as_output(),
                [_import_arg(dep, needs_ir) for dep in closure],
                ["--lean-flag=" + flag for flag in lean_flags],
                hidden = toolchain.stamp,
            )
            if allow_sorry:
                elab.add("--allow-sorry")
            if split:
                elab.add("--postpone")
            else:
                elab.add("--c-out", outputs[m.c].as_output(), "--empty-dir", outputs[m.sig].as_output(), "--empty-dir", outputs[m.ir].as_output())
            ctx.actions.run(elab, category = "lean_elab", identifier = name)

            if split:
                ctx.actions.run(
                    cmd_args(
                        toolchain.tool,
                        "ir",
                        "--module",
                        name,
                        "--package",
                        package,
                        "--options",
                        options_json,
                        "--self-dir",
                        outputs[m.elab],
                        "--sig-out",
                        outputs[m.sig].as_output(),
                        "--ir-out",
                        outputs[m.ir].as_output(),
                        "--c-out",
                        outputs[m.c].as_output(),
                        [_import_arg(dep, True, for_leanir = True) for dep in closure],
                        hidden = toolchain.stamp,
                    ),
                    category = "lean_ir",
                    identifier = name,
                )

    outputs = []
    for m in own.values():
        outputs += [m.elab, m.sig, m.ir, m.c]
    ctx.actions.dynamic_output(
        dynamic = [graph] + dep_graphs,
        inputs = [],
        outputs = [o.as_output() for o in outputs],
        f = compile,
    )

    sub_targets = {"imports.json": [DefaultInfo(default_output = graph)]}
    for m in own.values():
        sub_targets[m.name] = [DefaultInfo(default_outputs = [m.elab, m.sig, m.ir])]
        sub_targets[m.name + ".c"] = [DefaultInfo(default_output = m.c)]

    return [
        DefaultInfo(
            default_outputs = [m.elab for m in own.values()] + [m.c for m in own.values()],
            sub_targets = sub_targets,
        ),
        LeanLibraryInfo(
            package = package,
            options = options,
            own = list(own.keys()),
            modules = modules,
            graphs = dep_graphs + [graph],
        ),
    ]

lean_modules = rule(
    impl = _lean_modules_impl,
    attrs = {
        # Module name to source file
        "modules": attrs.dict(attrs.string(), attrs.source(), sorted = False),
        # Lean libraries; anything else (the C++ side of an @[extern]) is
        # ignored here and linked by the C++ rules
        "deps": attrs.list(attrs.dep(), default = []),
        # The package id Lean mangles into this library's symbols
        # (lp_<package>_..., initialize_<package>_...). Defaults to the
        # target name.
        "package": attrs.option(attrs.string(), default = None),
        "options": attrs.dict(attrs.string(), attrs.one_of(attrs.bool(), attrs.int(), attrs.string()), default = {}),
        "allow_sorry": attrs.bool(default = False),
        "warnings_as_errors": attrs.bool(default = False),
        # Generate code for `module` files in a separate leanir action. leanir
        # reads only the .ir.sig of what a module imports, and every .ir.sig
        # in the toolchain's own lib/lean is an empty placeholder, since
        # Lean's standard library is not built this way. So code that needs
        # the code generator's data for a stdlib function (for example
        # List.replicate in a fold, "Unknown constant
        # List.replicateTR._redArg") fails here. And code generated this
        # way fails the IR check ("unknown join point") of an importer that
        # generates its own code in one step, so it has to cover a whole
        # import closure. It is off by default.
        "split_codegen": attrs.bool(default = False),
        "lean_flags": attrs.list(attrs.string(), default = []),
        "_lean_toolchain": attrs.toolchain_dep(default = "toolchains//:lean", providers = [LeanToolchainInfo]),
    },
)

# MARK: Libraries

def _lean_library_impl(ctx: AnalysisContext) -> list[Provider]:
    native = ctx.attrs.native
    providers = [p for p in native.providers if not isinstance(p, DefaultInfo)]
    providers.append(ctx.attrs.lean[LeanLibraryInfo])
    providers.append(DefaultInfo(
        default_outputs = ctx.attrs.lean[DefaultInfo].default_outputs + native[DefaultInfo].default_outputs,
    ))
    return providers

lean_library_rule = rule(
    impl = _lean_library_impl,
    attrs = {
        "lean": attrs.dep(providers = [LeanLibraryInfo]),
        "native": attrs.dep(),
    },
)

# MARK: Tests

def _lean_test_impl(ctx: AnalysisContext) -> list[Provider]:
    toolchain = ctx.attrs._lean_toolchain[LeanToolchainInfo]
    info = ctx.attrs.lean[LeanLibraryInfo]
    own = [info.modules[name] for name in info.own]

    commands = []
    if ctx.attrs.leanchecker:
        commands.append(cmd_args(
            toolchain.tool,
            "check",
            [cmd_args("--import=", m.name, "=", m.elab, delimiter = "") for m in info.modules.values()],
            info.own,
        ))
    if ctx.attrs.binary:
        commands.append(cmd_args(ctx.attrs.binary[RunInfo], ctx.attrs.args))

    # Building the modules is the test of a proof. Elaboration fails on a
    # wrong one, and on `sorry` unless allowed.
    hidden = [m.elab for m in own]
    if not commands:
        commands.append(cmd_args("true"))
    script, _ = ctx.actions.write(
        "{}.sh".format(ctx.label.name),
        ["#!/usr/bin/env bash", "set -euo pipefail"] + [cmd_args(c, delimiter = " ", quote = "shell") for c in commands],
        is_executable = True,
        allow_args = True,
    )
    command = cmd_args(script, hidden = hidden + commands)
    return [
        DefaultInfo(default_outputs = hidden),
        RunInfo(args = command),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [command],
            env = ctx.attrs.env,
        ),
    ]

lean_test_rule = rule(
    impl = _lean_test_impl,
    attrs = {
        "args": attrs.list(attrs.arg(), default = []),
        "binary": attrs.option(attrs.dep(providers = [RunInfo]), default = None),
        "env": attrs.dict(attrs.string(), attrs.arg(), default = {}),
        "lean": attrs.dep(providers = [LeanLibraryInfo]),
        "leanchecker": attrs.bool(default = True),
        "_lean_toolchain": attrs.toolchain_dep(default = "toolchains//:lean", providers = [LeanToolchainInfo]),
    },
)

# MARK: Macros

_SHARED_ATTRS = ["compatible_with", "labels", "target_compatible_with", "visibility"]

_LEAN_ATTRS = ["allow_sorry", "lean_flags", "options", "package", "split_codegen", "warnings_as_errors"]

def _split(kwargs: dict, keys: list[str]) -> dict:
    return {k: kwargs.pop(k) for k in keys if k in kwargs}

def _modules_target(name: str, srcs: list[str], root: str, deps: list[str], lean_kwargs: dict, shared: dict) -> list[str]:
    modules = _modules(srcs, root)
    lean_modules(
        name = name,
        modules = modules,
        deps = deps,
        **dict(lean_kwargs, **shared)
    )
    return [":{}[{}.c]".format(name, m) for m in modules.keys()]

def lean_library(
        name: str,
        srcs: list[str],
        deps: list[str] = [],
        root: str = "",
        compiler_flags: list[str] = [],
        cxx_library = None,
        **kwargs):
    """Lean modules, compiled to a C++ library.

    `srcs` are .lean files whose module names follow their paths below
    `root` (a directory relative to this package). `deps` are Lean
    libraries and the C++ libraries implementing any @[extern] functions.
    `compiler_flags` go to the C compiler, after the toolchain's.

    The other Lean attributes (`package`, `options`, `allow_sorry`,
    `warnings_as_errors`, `split_codegen`, `lean_flags`) are documented on
    `lean_modules`.
    """
    cxx_library = cxx_library or native.cxx_library
    shared = _split(kwargs, _SHARED_ATTRS)
    lean_kwargs = _split(kwargs, _LEAN_ATTRS)
    lean_kwargs.setdefault("package", name)

    c_srcs = _modules_target(name + "--lean", srcs, root, deps, lean_kwargs, shared)
    cxx_library(
        name = name + "--native",
        srcs = c_srcs,
        deps = [RUNTIME] + deps,
        compiler_flags = LEAN_C_COMPILE_FLAGS + compiler_flags,
        # Lean's own runtime and standard library are static archives built
        # without -fPIC, so nothing linking them can be a shared object.
        preferred_linkage = "static",
        **shared
    )
    lean_library_rule(
        name = name,
        lean = ":{}--lean".format(name),
        native = ":{}--native".format(name),
        **dict(shared, **kwargs)
    )

def lean_binary(
        name: str,
        srcs: list[str],
        deps: list[str] = [],
        root: str = "",
        compiler_flags: list[str] = [],
        cxx_binary = None,
        **kwargs):
    """A Lean program; one of `srcs` defines `main`.

    Takes the attributes of `lean_library`; the rest go to `cxx_binary`.
    """
    cxx_binary = cxx_binary or native.cxx_binary
    shared = _split(kwargs, _SHARED_ATTRS)
    lean_kwargs = _split(kwargs, _LEAN_ATTRS)
    lean_kwargs.setdefault("package", name)

    c_srcs = _modules_target(name + "--lean", srcs, root, deps, lean_kwargs, shared)
    cxx_binary(
        name = name,
        srcs = c_srcs,
        deps = [RUNTIME] + deps,
        compiler_flags = LEAN_C_COMPILE_FLAGS + compiler_flags,
        **dict(shared, **kwargs)
    )

def lean_test(
        name: str,
        srcs: list[str],
        deps: list[str] = [],
        root: str = "",
        executable: bool = False,
        leanchecker: bool = True,
        args: list[str] = [],
        env: dict[str, str] = {},
        compiler_flags: list[str] = [],
        cxx_binary = None,
        **kwargs):
    """Lean modules checked as a test.

    The modules elaborate at build time, so a failed proof (or `sorry`,
    unless `allow_sorry`) fails the test. With `leanchecker` (the default)
    the test also replays every declaration of its own modules through the
    kernel. With `executable`, one of `srcs` defines `main`, and the test
    runs the program with `args` and `env` and passes if it exits 0.
    """
    shared = _split(kwargs, _SHARED_ATTRS)
    lean_kwargs = _split(kwargs, _LEAN_ATTRS)
    lean_kwargs.setdefault("package", name)

    lean_target = name + "--lean"
    c_srcs = _modules_target(lean_target, srcs, root, deps, lean_kwargs, shared)
    binary = None
    if executable:
        binary = ":{}--bin".format(name)
        (cxx_binary or native.cxx_binary)(
            name = name + "--bin",
            srcs = c_srcs,
            deps = [RUNTIME] + deps,
            compiler_flags = LEAN_C_COMPILE_FLAGS + compiler_flags,
            **shared
        )
    lean_test_rule(
        name = name,
        lean = ":" + lean_target,
        binary = binary,
        leanchecker = leanchecker,
        args = args,
        env = env,
        **dict(shared, **kwargs)
    )

lean = struct(
    library = lean_library,
    binary = lean_binary,
    test = lean_test,
)
