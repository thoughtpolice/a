# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Build gameplay modules with gameplayc, from C# and WIT.

    load("tilde//aseipp/cs2wasm:defs.bzl", "gameplay")

    gameplay.bindings(name = "bindings", wit = ":sdk.wit", world = "game")
    gameplay.module(name = "game", srcs = [":bindings", "Game.cs"])
    gameplay.component(name = "game-component", module = ":game", wit = [":sdk.wit"], world = "game")

`bindings` runs witgen over a WIT package and yields the C# file a module
implements the world with; `module` compiles C# sources into one Wasm module;
`component` wraps that module into a component implementing the world with
`wlink componentize`, which also verifies that the module's imports and
exports are the world's.
"""

load("@root//buck/shims:shims.bzl", depot = "shims")

GAMEPLAYC = "tilde//aseipp/cs2wasm:gameplayc"
WITGEN = "tilde//aseipp/cs2wasm:witgen"
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

def gameplay_module(
        name,
        srcs,
        fuel = None,
        depth = None,
        alloc_units = None,
        max_array = None,
        visibility = None):
    """One Wasm module compiled from C# sources (files or generated
    bindings), with gameplayc's runtime budgets optionally overridden."""
    options = []
    for flag, value in [("--fuel", fuel), ("--depth", depth), ("--alloc-units", alloc_units), ("--max-array", max_array)]:
        if value != None:
            options.append("{} {}".format(flag, value))
    depot.genrule(
        name = name,
        srcs = srcs,
        out = name + ".wasm",
        cmd = "$(exe {}) {} -o $OUT $SRCS".format(GAMEPLAYC, " ".join(options)),
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
    module = gameplay_module,
    component = gameplay_component,
)
