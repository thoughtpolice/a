# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Chez Scheme: libraries, programs, boot files and standalone executables.

    load("@toolchains//chez:defs.bzl", "chez")

    chez.library(
        name = "core",
        srcs = glob(["core/*.sls"]),
        strip_prefix = "core",      # core/text.sls ...
        prefix = "quad",            # ... is quad/text.sls: (quad text)
        deps = ["//other:lib"],
    )
    chez.program(name = "main", src = "main.ss", deps = [":core"])
    chez.boot(name = "app", deps = [":main"])          # app.boot
    chez.standalone(name = "app-bin", kernel = ":kernel", boots = [":app"])

Rust procedures (the chez crate, src/crates/chez) become a Scheme library
with chez.rust_library, which writes the library their chez::library!
describes:

    chez.rust_library(name = "native", crate = ":native-rs", library = "native")

A library target compiles its sources against its dependencies' compiled
objects only, so a change recompiles the targets downstream of it and no
others. Each target records its libraries in import order, and a boot file
loads every library its dependencies need, each after the ones it imports,
then its programs, which run as it loads.

A standalone executable is a kernel -- a C program that links Chez Scheme's
kernel (toolchains//chez:kernel) and boots with chez_embed_register
(toolchains//chez:embed) -- with Chez Scheme's boot files and the given ones
appended (embed.sls has the layout).
"""

load("@prelude//cxx:cxx_toolchain_types.bzl", "CxxToolchainInfo")
load("@root//buck/shims:shims.bzl", "shims")

# The Scheme half of the chez crate: (chez rust).
CHEZ_RUST_SCHEME = "root//src/crates/chez:scheme"

ChezToolchainInfo = provider(fields = {
    "scheme": provider_field(typing.Any),
    "petite_boot": provider_field(typing.Any),
    "scheme_boot": provider_field(typing.Any),
    "compile": provider_field(typing.Any),
    "boot": provider_field(typing.Any),
    "pack": provider_field(typing.Any),
    "embed_libdir": provider_field(typing.Any),
})

def _chez_toolchain_impl(ctx: AnalysisContext) -> list[Provider]:
    return [
        DefaultInfo(),
        ChezToolchainInfo(
            scheme = ctx.attrs.scheme[RunInfo].args,
            petite_boot = ctx.attrs.petite_boot,
            scheme_boot = ctx.attrs.scheme_boot,
            compile = ctx.attrs.compile,
            boot = ctx.attrs.boot,
            pack = ctx.attrs.pack,
            embed_libdir = ctx.actions.symlinked_dir("embed-lib", {"chez/embed.sls": ctx.attrs.embed_sls}),
        ),
    ]

chez_toolchain = rule(
    impl = _chez_toolchain_impl,
    attrs = {
        "boot": attrs.source(),
        "compile": attrs.source(),
        "embed_sls": attrs.source(),
        "pack": attrs.source(),
        "petite_boot": attrs.source(),
        "scheme": attrs.exec_dep(providers = [RunInfo]),
        "scheme_boot": attrs.source(),
    },
    is_toolchain_rule = True,
)

# MARK: Providers

def _compile_projection(value):
    return cmd_args(value.objdir, format = "dep={}")

def _boot_projection(value):
    return cmd_args("lib=", value.objdir, ":", value.manifest, delimiter = "")

# Each node: one library target's objects and its manifest.
ChezLibrariesTSet = transitive_set(args_projections = {
    "boot": _boot_projection,
    "compile": _compile_projection,
})

ChezLibraryInfo = provider(fields = {
    # The target's libraries and every dependency's.
    "libraries": provider_field(typing.Any),
})

ChezProgramInfo = provider(fields = {
    "object": provider_field(typing.Any),
    "libraries": provider_field(typing.Any),
})

ChezBootInfo = provider(fields = {
    "boot": provider_field(typing.Any),
})

def _toolchain(ctx):
    return ctx.attrs._chez_toolchain[ChezToolchainInfo]

def _deps_tset(ctx):
    children = []
    for d in ctx.attrs.deps:
        if ChezLibraryInfo in d:
            children.append(d[ChezLibraryInfo].libraries)
        elif ChezProgramInfo in d:
            children.append(d[ChezProgramInfo].libraries)
    return ctx.actions.tset(ChezLibrariesTSet, children = children)

def _flags(ctx):
    return [
        "opt={}".format(ctx.attrs.opt),
        "debug=" + ("yes" if ctx.attrs.debug else "no"),
    ]

_COMMON_ATTRS = {
    "debug": attrs.bool(default = False, doc = "Keep inspector information."),
    "deps": attrs.list(attrs.dep(), default = []),
    "opt": attrs.int(default = 2, doc = "Chez Scheme's optimize-level."),
    "_chez_toolchain": attrs.toolchain_dep(default = "toolchains//:chez", providers = [ChezToolchainInfo]),
}

# MARK: Libraries

def _chez_library_impl(ctx: AnalysisContext) -> list[Provider]:
    tc = _toolchain(ctx)
    srcdir = ctx.actions.symlinked_dir("src", ctx.attrs.srcs)
    objdir = ctx.actions.declare_output("obj", dir = True)
    manifest = ctx.actions.declare_output("manifest.ss")
    deps = _deps_tset(ctx)
    ctx.actions.run(
        cmd_args(
            tc.scheme,
            "-q",
            "--script",
            tc.compile,
            cmd_args(srcdir, format = "src={}"),
            cmd_args(objdir.as_output(), format = "out={}"),
            cmd_args(manifest.as_output(), format = "manifest={}"),
            ["lib=" + rel for rel in sorted(ctx.attrs.srcs.keys()) if rel.endswith(".sls")],
            deps.project_as_args("compile"),
            _flags(ctx),
        ),
        category = "chez_compile",
    )
    libraries = ctx.actions.tset(
        ChezLibrariesTSet,
        value = struct(objdir = objdir, manifest = manifest),
        children = [deps],
    )
    return [
        DefaultInfo(default_outputs = [objdir], sub_targets = {
            "manifest": [DefaultInfo(default_output = manifest)],
            "src": [DefaultInfo(default_output = srcdir)],
        }),
        ChezLibraryInfo(libraries = libraries),
    ]

_chez_library = rule(
    impl = _chez_library_impl,
    attrs = _COMMON_ATTRS | {
        # Library path ("quad/text.sls") -> source. Files that are not .sls
        # are there to be included.
        "srcs": attrs.dict(attrs.string(), attrs.source(), default = {}),
    },
)

def _layout(srcs, prefix, strip_prefix):
    if type(srcs) == type({}):
        return srcs
    out = {}
    for src in srcs:
        rel = src.removeprefix(strip_prefix + "/") if strip_prefix else src
        out[(prefix + "/" + rel) if prefix else rel] = src
    return out

def _library(name, srcs = [], prefix = "", strip_prefix = "", **kwargs):
    """Chez Scheme libraries: `srcs` laid out by library name.

    `srcs` maps library paths ("quad/text.sls") to sources, or is a list of
    files, each placed at its path less `strip_prefix`, under `prefix`.
    """
    _chez_library(name = name, srcs = _layout(srcs, prefix, strip_prefix), **kwargs)

# MARK: Programs

def _chez_program_impl(ctx: AnalysisContext) -> list[Provider]:
    tc = _toolchain(ctx)
    srcdir = ctx.actions.symlinked_dir("src", {"main.ss": ctx.attrs.src} | ctx.attrs.includes)
    obj = ctx.actions.declare_output(ctx.label.name + ".so")
    deps = _deps_tset(ctx)
    ctx.actions.run(
        cmd_args(
            tc.scheme,
            "-q",
            "--script",
            tc.compile,
            cmd_args(srcdir, format = "src={}"),
            "program=main.ss",
            cmd_args(obj.as_output(), format = "out={}"),
            deps.project_as_args("compile"),
            _flags(ctx),
        ),
        category = "chez_compile_program",
    )
    return [
        DefaultInfo(default_output = obj),
        ChezProgramInfo(object = obj, libraries = deps),
    ]

_chez_program = rule(
    impl = _chez_program_impl,
    attrs = _COMMON_ATTRS | {
        "includes": attrs.dict(attrs.string(), attrs.source(), default = {}),
        "src": attrs.source(),
    },
)

# MARK: Boot files

def _chez_boot_impl(ctx: AnalysisContext) -> list[Provider]:
    tc = _toolchain(ctx)
    boot = ctx.actions.declare_output(ctx.label.name + ".boot")
    programs = [d[ChezProgramInfo].object for d in ctx.attrs.deps if ChezProgramInfo in d]
    ctx.actions.run(
        cmd_args(
            tc.scheme,
            "-q",
            "--script",
            tc.boot,
            cmd_args(boot.as_output(), format = "out={}"),
            "requires=" + ",".join(ctx.attrs.requires),
            _deps_tset(ctx).project_as_args("boot", ordering = "postorder"),
            [cmd_args(p, format = "program={}") for p in programs],
            "strip=" + ("yes" if ctx.attrs.strip else "no"),
        ),
        category = "chez_boot",
    )
    return [
        DefaultInfo(default_output = boot),
        ChezBootInfo(boot = boot),
    ]

_chez_boot = rule(
    impl = _chez_boot_impl,
    attrs = {
        "deps": attrs.list(attrs.dep(), default = []),
        # The boot files this one runs on top of: "petite" alone, without
        # the compiler, or "scheme" too.
        "requires": attrs.list(attrs.string(), default = ["scheme", "petite"]),
        "strip": attrs.bool(default = False, doc = "Drop inspector and source information."),
        "_chez_toolchain": attrs.toolchain_dep(default = "toolchains//:chez", providers = [ChezToolchainInfo]),
    },
)

# MARK: Standalone executables

def _chez_standalone_impl(ctx: AnalysisContext) -> list[Provider]:
    tc = _toolchain(ctx)
    name = ctx.attrs.out or ctx.label.name
    out = ctx.actions.declare_output(name)
    kernel_exe = ctx.attrs.kernel[DefaultInfo].default_outputs[0]
    sub_targets = {}
    if ctx.attrs.strip:
        # What the kernel carries for debuggers and profilers -- its symbol
        # table, the skeleton DWARF that points at split debug info, and
        # the relocations --emit-relocs keeps for BOLT -- goes into a file
        # of its own, which the executable names (.gnu_debuglink) so that
        # gdb and perf find it beside it. The boot files go after the
        # stripped kernel, since stripping rewrites the ELF file and would
        # drop anything appended to it.
        objcopy = ctx.attrs._cxx_toolchain[CxxToolchainInfo].binary_utilities_info.objcopy
        debug = ctx.actions.declare_output(name + ".debug")
        stripped = ctx.actions.declare_output("stripped", name)
        ctx.actions.run(
            cmd_args(objcopy, "--only-keep-debug", kernel_exe, debug.as_output()),
            category = "chez_standalone_debug",
        )
        ctx.actions.run(
            cmd_args(
                objcopy,
                "--strip-all",
                cmd_args(debug, format = "--add-gnu-debuglink={}"),
                kernel_exe,
                stripped.as_output(),
            ),
            category = "chez_standalone_strip",
        )
        kernel_exe = stripped
        sub_targets["debug"] = [DefaultInfo(default_output = debug)]
    runtime = {
        "petite": [("petite", tc.petite_boot)],
        "scheme": [("petite", tc.petite_boot), ("scheme", tc.scheme_boot)],
    }[ctx.attrs.runtime]
    boots = runtime + [(d.label.name[:16], d[ChezBootInfo].boot) for d in ctx.attrs.boots]
    ctx.actions.run(
        cmd_args(
            tc.scheme,
            "-q",
            "--libdirs",
            tc.embed_libdir,
            "--script",
            tc.pack,
            out.as_output(),
            kernel_exe,
            [cmd_args(path, format = name + "={}") for name, path in boots],
        ),
        category = "chez_standalone",
    )
    return [
        DefaultInfo(default_output = out, sub_targets = sub_targets),
        RunInfo(args = cmd_args(out)),
    ]

_chez_standalone = rule(
    impl = _chez_standalone_impl,
    attrs = {
        "boots": attrs.list(attrs.dep(providers = [ChezBootInfo]), default = []),
        "kernel": attrs.dep(),
        "out": attrs.option(attrs.string(), default = None),
        "runtime": attrs.enum(["petite", "scheme"], default = "scheme"),
        "strip": attrs.bool(
            default = True,
            doc = "Strip the kernel's symbols and debug info into the [debug] sub-target, a file the executable names.",
        ),
        "_chez_toolchain": attrs.toolchain_dep(default = "toolchains//:chez", providers = [ChezToolchainInfo]),
        "_cxx_toolchain": attrs.toolchain_dep(default = "toolchains//:cxx", providers = [CxxToolchainInfo]),
    },
)

# MARK: Rust libraries

def _rust_library(name, crate, library, crate_name = None, deps = [], visibility = None, **kwargs):
    """The Scheme library binding a Rust crate's procedures.

    `crate` is a rust_library whose `library` function is defined with
    chez::library!; `crate_name` is its crate name if not derivable from the
    target name. The Scheme library, named as chez::library! names it, is
    generated by running a program that prints its source. `deps` are other
    chez libraries it needs.
    """
    crate_name = crate_name or crate.split(":")[-1].replace("-", "_")
    shims.write_file(
        name = name + "-gen.rs",
        contents = [
            "// Generated by chez.rust_library: print the Scheme library.",
            "fn main() {",
            "    print!(\"{{}}\", ::{}::{}().scheme_source());".format(crate_name, library),
            "}",
            "",
        ],
    )
    shims.rust_binary(
        name = name + "-gen",
        srcs = [":{}-gen.rs".format(name)],
        crate_root = "{}-gen.rs".format(name),
        deps = [crate],
    )
    shims.genrule(
        name = name + ".sls",
        out = name + ".sls",
        cmd = "$(exe :{}-gen) > $OUT".format(name),
    )
    _chez_library(
        name = name,
        srcs = {"@generated/{}.sls".format(name): ":{}.sls".format(name)},
        deps = [CHEZ_RUST_SCHEME] + deps,
        visibility = visibility,
        **kwargs
    )

chez = struct(
    rust_library = _rust_library,
    library = _library,
    program = _chez_program,
    boot = _chez_boot,
    standalone = _chez_standalone,
)
