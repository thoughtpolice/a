# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Build gameplay modules with gameplayc, from C# and WIT.

    load("tilde//aseipp/cs2wasm:defs.bzl", "gameplay")

    gameplay.bindings(name = "bindings", wit = ":sdk.wit", world = "game")
    gameplay.library(name = "engine", srcs = glob(["engine/*.cs"]))
    gameplay.module(name = "game", srcs = [":bindings", "Game.cs"], deps = [":engine"])
    gameplay.component(name = "game-component", module = ":game", wit = [":sdk.wit"], world = "game")

`bindings` runs witgen over a WIT package and yields the C# file a module
implements the world with; `library` compiles C# sources into a gameplay
library, which modules and other libraries compile against and whose IL a
module that references it includes as its own; `module` compiles C#
sources (and the libraries of its `deps`) into one Wasm module; `component`
wraps that module into a component implementing the world with
`wlink componentize`, which also verifies that the module's imports and
exports are the world's.
"""

load("@root//buck/shims:shims.bzl", depot = "shims")

GAMEPLAYC = "tilde//aseipp/cs2wasm:gameplayc"
WITGEN = "tilde//aseipp/witgen:witgen"
WLINK = "tilde//aseipp/wlink:wlink"

def _locations(targets):
    return " ".join(["$(location {})".format(target) for target in targets])

def gameplay_bindings(name, wit, world, deps = [], namespace = None, strict = False, visibility = None):
    """C# bindings for `world` of the WIT package `wit` (a file or package
    directory), whose dependencies `deps` come first in dependency order.

    With `strict`, a function or type the bindings cannot express fails the
    build rather than being left out with a comment."""
    command = "$(exe {}) csharp {} --world {} -o $OUT".format(WITGEN, _locations(deps + [wit]), world)
    if namespace:
        command += " --namespace " + namespace
    if strict:
        command += " --strict"
    depot.genrule(
        name = name,
        out = name + ".g.cs",
        cmd = command,
        visibility = visibility,
    )

def _references(deps):
    return "".join([" --reference $(location {})".format(dep) for dep in deps])

def gameplay_library(
        name,
        srcs,
        deps = [],
        generators = [],
        runtime_async = False,
        assembly_name = None,
        visibility = None):
    """A gameplay library compiled from C# sources: an assembly named
    `assembly_name` (the target's name by default) and its PDB, in a
    directory with those of the libraries it references (`deps`, other
    `library` targets), which is what a module or library referencing it
    names with `gameplayc --reference`.

    A library is compiled as a module's sources are, against the same
    gameplay API, so it compiles only if every module can use it; its
    `generators` run over its own sources (a generator that must see a
    game's sources belongs to the module instead). A library does not
    export or import: WasmImport, WasmExport and bindings are the
    module's."""
    assembly = assembly_name or name
    command = "mkdir -p $OUT && $(exe {}) --library {}".format(GAMEPLAYC, assembly)
    if runtime_async:
        command += " --runtime-async"
    for generator in generators:
        command += " --generator $(location {})".format(generator)
    command += _references(deps) + " -o $OUT/{}.dll $SRCS".format(assembly)
    for dep in deps:
        command += " && cp $(location {})/* $OUT/".format(dep)
    depot.genrule(
        name = name,
        srcs = srcs,
        out = name,
        cmd = command,
        visibility = visibility,
    )

def gameplay_module(
        name,
        srcs,
        deps = [],
        fuel = None,
        depth = None,
        alloc_units = None,
        max_array = None,
        runtime_async = False,
        generators = [],
        visibility = None):
    """One Wasm module compiled from C# sources (files or generated
    bindings), with gameplayc's runtime budgets optionally overridden, and
    with `runtime_async` its async methods compiled as runtime-async
    methods, which the compiler splits itself.

    `generators` are Roslyn source generator assemblies (`csharp.library`
    targets compiled against third-party//csharp:Microsoft.CodeAnalysis.CSharp),
    whose generators run over the sources as csc's `/analyzer:` runs them.

    `deps` are `library` targets the sources compile against; their IL
    (and that of the libraries they reference) is compiled into the module
    as the module's own code."""
    options = []
    for flag, value in [("--fuel", fuel), ("--depth", depth), ("--alloc-units", alloc_units), ("--max-array", max_array)]:
        if value != None:
            options.append("{} {}".format(flag, value))
    if runtime_async:
        options.append("--runtime-async")
    for generator in generators:
        options.append("--generator $(location {})".format(generator))
    depot.genrule(
        name = name,
        srcs = srcs,
        out = name + ".wasm",
        cmd = "$(exe {}) {}{} -o $OUT $SRCS".format(GAMEPLAYC, " ".join(options), _references(deps)),
        visibility = visibility,
    )

def gameplay_component(name, module, wit, world, visibility = None):
    """The module as a component implementing `world`; `wit` names the
    package files or directories in dependency order."""
    depot.genrule(
        name = name,
        out = name + ".wasm",
        cmd = "$(exe {}) componentize $(location {}) {} --world {} -o $OUT".format(
            WLINK,
            module,
            " ".join(["--wit $(location {})".format(path) for path in wit]),
            world,
        ),
        visibility = visibility,
    )

gameplay = struct(
    bindings = gameplay_bindings,
    library = gameplay_library,
    module = gameplay_module,
    component = gameplay_component,
)
