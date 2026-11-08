# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Flags, rules and helpers for BUILD's Slang libraries."""

load("@root//buck/shims:shims.bzl", "shims")

# The hosts BUILD configures, as config//os constraints.
OSES = [
    "config//os:linux",
    "config//os:macos",
    "config//os:windows",
]

# cmake/CompilerFlags.cmake's set_default_compile_options(), which every
# Slang target gets: C++20, hidden visibility, and the configuration's
# feature switches. _DEBUG, which CMake adds in Debug builds, is left out in
# every mode: it turns on Slang's internal checks, and the bootstrap
# compiling the core module with them is slow.
#
# On Windows, clang-cl takes MSVC's spellings, has no visibility to hide
# (only what is declared dllexport leaves a DLL), and needs C++ exceptions
# turned on, as CMake's default /EHsc does for MSVC-like compilers.
SLANG_COMPILER_FLAGS = shims.select({
    "config//os:windows": [
        "/std:c++20",
        "/EHsc",
    ],
    "DEFAULT": [
        "-std=c++20",
        "-fvisibility=hidden",
        "-fvisibility-inlines-hidden",
    ],
})

# The same function's definitions. The ones for windows.h (a lean
# <windows.h> without min and max macros, and the wide-character API) CMake
# defines on every host; they only mean anything on Windows, so they are
# only given there.
SLANG_DEFINES = [
    "-DSLANG_ENABLE_DXIL_SUPPORT=1",
    "-DSLANG_ENABLE_WEBGPU=0",
    "-DSLANG_ENABLE_VALIDATION_VM_BYTECODE=1",
    "-DSLANG_ENABLE_VALIDATION_FOSSIL=0",
] + shims.select({
    "config//os:windows": [
        "-DWIN32_LEAN_AND_MEAN",
        "-DVC_EXTRALEAN",
        "-DNOMINMAX",
        "-DUNICODE",
        "-D_UNICODE",
    ],
    "DEFAULT": [],
})

# slang_add_target()'s EXPORT_MACRO_PREFIX SLANG for a target that ends up
# in the shared library: slang.h's SLANG_API then exports.
SLANG_DYNAMIC_EXPORT = [
    "-DSLANG_DYNAMIC",
    "-DSLANG_DYNAMIC_EXPORT",
]

def slang_library(name, preprocessor_flags = [], **kwargs):
    """A static library of Slang objects, with the flags every target has."""
    shims.cxx_library(
        name = name,
        compiler_flags = SLANG_COMPILER_FLAGS,
        preferred_linkage = "static",
        preprocessor_flags = SLANG_DEFINES + preprocessor_flags,
        **kwargs
    )

def src(path):
    """A file of the source archive."""
    return ":src[{}]".format(path)

def per_os(libraries, field):
    """`field` of the entry for the target's OS in `libraries`, a dict of
    structs keyed by OS constraint."""
    return shims.select({
        os: getattr(names, field)
        for os, names in libraries.items()
    })

# cmake/Glob.cmake's slang_glob_sources() filters, by the directories a
# source sits in: which hosts build what is in each.
_HOST_DIRECTORIES = {
    "metal": ["config//os:macos"],
    "open-gl": ["config//os:windows"],
    "unix": [
        "config//os:linux",
        "config//os:macos",
    ],
    "windows": ["config//os:windows"],
}

def _for_host(path, os):
    for directory in path.split("/")[:-1]:
        hosts = _HOST_DIRECTORIES.get(directory)
        if directory.startswith("d3d"):
            # Without DX-on-Vulkan, which this build leaves off.
            hosts = ["config//os:windows"]
        if hosts != None and os not in hosts:
            return False
    return True

def host_sources(files, flags = {}):
    """srcs of `files`, sources of the archive as sources.bzl lists them: the
    ones the target's host builds, as slang_glob_sources() picks them. A
    file whose basename `flags` names is compiled with the flags it gives,
    a dict of flag lists keyed by OS constraint or "DEFAULT"."""

    def source(f, os):
        file_flags = flags.get(f.split("/")[-1])
        if file_flags == None:
            return src(f)
        return (src(f), file_flags.get(os, file_flags.get("DEFAULT", [])))

    return shims.select({
        os: [source(f, os) for f in files if _for_host(f, os)]
        for os in OSES
    })

# MARK: Portable build steps

# Slang's build runs its generators through CMake, which needs no shell on
# any host: add_custom_command() runs a command in a working directory, and
# configure_file() and install() write files. These rules do the same
# through step.py, a Python script, so that the steps run alike under
# Linux, macOS and Windows hosts.

_STEP = "third-party//by-name/sl/slang:step"

def _custom_command_impl(ctx: AnalysisContext) -> list[Provider]:
    out = ctx.actions.declare_output(ctx.label.name, dir = True)

    # The command runs from its working directory, so the paths in it are
    # made absolute: step.py puts the project root where $ROOT stands.
    cmd = cmd_args(ctx.attrs._step[RunInfo], "run", "--out", out.as_output())
    if ctx.attrs.working_directory != None:
        cmd.add("--cwd", cmd_args(ctx.attrs.working_directory, absolute_prefix = "$ROOT/"))
    for name, path in ctx.attrs.scratch.items():
        cmd.add("--scratch", name, cmd_args(path, absolute_prefix = "$ROOT/"))
    for name in ctx.attrs.unchanged:
        cmd.add("--unchanged", name)
    for i, command in enumerate(ctx.attrs.cmds):
        cmd.add("--" if i == 0 else "&&", cmd_args(command, absolute_prefix = "$ROOT/"))
    ctx.actions.run(cmd, category = "custom_command")

    return [DefaultInfo(
        default_output = out,
        sub_targets = {
            name: [DefaultInfo(default_output = out.project(name))]
            for name in ctx.attrs.outs
        },
    )]

custom_command = rule(
    impl = _custom_command_impl,
    doc = """
        add_custom_command(): `cmds`, each a command line run in turn
        (without a shell) from `working_directory`, or the project root,
        that writes its outputs into the directory $OUT. Each entry of
        `scratch` is copied, writable, to $SCRATCH/<name> first, for a
        command that rewrites its inputs; one named in `unchanged` must
        match its original afterwards. The files named in `outs` are
        sub-targets.
    """,
    attrs = {
        "cmds": attrs.list(attrs.list(attrs.arg())),
        "outs": attrs.list(attrs.string(), default = []),
        "scratch": attrs.dict(attrs.string(), attrs.arg(), default = {}),
        "unchanged": attrs.list(attrs.string(), default = []),
        "working_directory": attrs.option(attrs.arg(), default = None),
        "_step": attrs.default_only(attrs.exec_dep(providers = [RunInfo], default = _STEP)),
    },
)

def _configure_file_impl(ctx: AnalysisContext) -> list[Provider]:
    out = ctx.actions.declare_output(ctx.attrs.out)
    ctx.actions.run(
        cmd_args(
            ctx.attrs._step[RunInfo],
            "configure",
            ctx.attrs.src,
            out.as_output(),
            ["{}={}".format(name, value) for name, value in ctx.attrs.values.items()],
        ),
        category = "configure_file",
    )
    return [DefaultInfo(default_output = out)]

configure_file = rule(
    impl = _configure_file_impl,
    doc = """
        configure_file(... @ONLY): `src` with each @NAME@ replaced by
        `values`' NAME.
    """,
    attrs = {
        "out": attrs.string(),
        "src": attrs.source(),
        "values": attrs.dict(attrs.string(), attrs.string()),
        "_step": attrs.default_only(attrs.exec_dep(providers = [RunInfo], default = _STEP)),
    },
)

def _install_tree_impl(ctx: AnalysisContext) -> list[Provider]:
    tree = ctx.actions.declare_output(ctx.label.name, dir = True)
    cmd = cmd_args(ctx.attrs._step[RunInfo], "install", tree.as_output())
    for path, source in ctx.attrs.files.items():
        cmd.add("--file", path, source)
    for path, target in ctx.attrs.symlinks.items():
        cmd.add("--symlink", path, target)
    ctx.actions.run(cmd, category = "install")

    providers = [DefaultInfo(default_output = tree)]
    if ctx.attrs.executable != None:
        # The whole tree goes with the executable: what it loads from beside
        # itself is part of it.
        providers.append(RunInfo(args = cmd_args(tree.project(ctx.attrs.executable), hidden = tree)))
    return providers

install_tree = rule(
    impl = _install_tree_impl,
    doc = """
        install(): a directory of `files` (copies, keyed by their paths in
        it) and `symlinks` (relative links, keyed likewise). It runs as
        `executable`, a path among `files`, if one is given.
    """,
    attrs = {
        "executable": attrs.option(attrs.string(), default = None),
        "files": attrs.dict(attrs.string(), attrs.source()),
        "symlinks": attrs.dict(attrs.string(), attrs.string(), default = {}),
        "_step": attrs.default_only(attrs.exec_dep(providers = [RunInfo], default = _STEP)),
    },
)
