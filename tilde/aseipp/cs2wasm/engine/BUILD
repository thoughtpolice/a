# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("//aseipp/cs2wasm:defs.bzl", "gameplay")
load("//aseipp/wlink/demo/sdk:defs.bzl", "console_headless", "console_link")
load(":defs.bzl", "KILN_CORE", "KILN_PLATFORM")

# Kiln's world generator: the Roslyn source generator that writes each
# program's schedule (its components' ids and storage, its query loops, the
# phases' order) from its attributes and those of its Kiln libraries.
depot.csharp.library(
    name = "generator",
    srcs = glob(["generator/*.cs"]),
    assembly_name = "Kiln.Generator",
    lang_version = "14.0",
    nullable = "enable",
    visibility = ["PUBLIC"],
    warnings_as_errors = True,
    deps = ["third-party//csharp:Microsoft.CodeAnalysis.CSharp"],
)

[
    depot.export_file(
        name = path,
        src = path,
        visibility = ["PUBLIC"],
    )
    for path in glob([
        "core/*.cs",
        "platform/*.cs",
        "tests/diagnostics/*.cs",
    ])
]

# The engine: the world, its storage and schedule's base, coroutines and
# the services (drawing, sound, tweens, particles, collision), compiled
# once into a gameplay library every Kiln program references. It is a Kiln
# library itself (the world's particles and their ageing join every
# program's schedule), so it is compiled with the generator.
gameplay.library(
    name = "kiln",
    srcs = KILN_CORE,
    assembly_name = "Kiln",
    generators = [":generator"],
    visibility = ["PUBLIC"],
)

# The same sources as a CLR library, for the CLR side of the tests.
depot.csharp.library(
    name = "kiln-clr",
    srcs = KILN_CORE,
    analyzers = [":generator"],
    assembly_name = "Kiln",
    lang_version = "15.0",
    nullable = "disable",
    warnings_as_errors = True,
)

# tests/plugin: a Kiln library contributing components, a resource, an
# event, a bundle and systems to the programs that reference it.
gameplay.library(
    name = "test-plugin",
    srcs = ["tests/plugin/Spinning.cs"],
    assembly_name = "Kiln.Tests.Plugin",
    generators = [":generator"],
    deps = [":kiln"],
)

depot.csharp.library(
    name = "test-plugin-clr",
    srcs = ["tests/plugin/Spinning.cs"],
    analyzers = [":generator"],
    assembly_name = "Kiln.Tests.Plugin",
    lang_version = "15.0",
    nullable = "disable",
    warnings_as_errors = True,
    deps = [":kiln-clr"],
)

# The engine's own tests, as gameplay code: compiled by gameplayc with the
# generator into a module over the Kiln library and the test plugin, and
# by csc with the generator as an analyzer over their CLR builds into the
# CLR program tests/engine.mjs compares it with.
gameplay.module(
    name = "tests",
    srcs = [
        "tests/Ecs.cs",
        "tests/Services.cs",
    ],
    # The checks are whole scenarios in one call each, heavier than a
    # frame of a game.
    fuel = 1000000,
    generators = [":generator"],
    deps = [
        ":kiln",
        ":test-plugin",
    ],
)

depot.csharp.binary(
    name = "tests-clr",
    srcs = [
        "tests/Ecs.cs",
        "tests/Program.cs",
        "tests/Services.cs",
        "//aseipp/cs2wasm:sdk/Frames.cs",
    ],
    analyzers = [":generator"],
    lang_version = "15.0",
    nullable = "disable",
    profile = "jit",
    warnings_as_errors = True,
    deps = [
        ":kiln-clr",
        ":test-plugin-clr",
    ],
)

# tests/Wide.cs: a program of 133 components, the plugin's among them,
# whose entities' components are three words; tests/engine.mjs's `wide`
# suite compares it with the CLR's and with its own model.
gameplay.module(
    name = "wide",
    srcs = ["tests/Wide.cs"],
    # A model's whole run is one call, its trace kept to hash.
    alloc_units = 16777216,
    fuel = 1000000,
    generators = [":generator"],
    deps = [
        ":kiln",
        ":test-plugin",
    ],
)

depot.csharp.binary(
    name = "wide-clr",
    srcs = [
        "tests/Program.cs",
        "tests/Wide.cs",
        "//aseipp/cs2wasm:sdk/Frames.cs",
    ],
    analyzers = [":generator"],
    lang_version = "15.0",
    nullable = "disable",
    profile = "jit",
    warnings_as_errors = True,
    deps = [
        ":kiln-clr",
        ":test-plugin-clr",
    ],
)

depot.deno.run(
    name = "engine",
    src = "tests/engine.mjs",
    permissions = [
        "env",
        "read",
        "run",
        "write",
    ],
)

# The engine's checks in Wasm against the CLR's.
depot.command_test(
    name = "engine-test",
    script = """
        out=`mktemp -d`
        trap 'rm -rf "$out"' EXIT
        export DOTNET_ROOT="$PWD/$(location toolchains//csharp:dotnet)"
        $(exe :engine) $(location :tests) "$out" $(exe :tests-clr)
    """,
)

# Past a word of components: the wide program's checks in Wasm against the
# CLR's and its model's.
depot.command_test(
    name = "wide-test",
    script = """
        out=`mktemp -d`
        trap 'rm -rf "$out"' EXIT
        export DOTNET_ROOT="$PWD/$(location toolchains//csharp:dotnet)"
        $(exe :engine) --suite wide $(location :wide) "$out" $(exe :wide-clr)
    """,
)

# The generator's diagnostics surface as the compiler's: each program under
# tests/diagnostics fails with its errors (Ambiguous.cs compiles, with its
# warning), located in its source; Library.cs is a Kiln library whose
# declarations must be public, and Unscheduled.cs a program over the same
# library compiled without the generator (so no Kiln library, whose
# declarations cannot join its schedule).
depot.command_test(
    name = "diagnostics-test",
    script = """
        out=`mktemp -d`
        trap 'rm -rf "$out"' EXIT
        compile() {
            $(exe //aseipp/cs2wasm:gameplayc) --generator $(location :generator) --reference $(location :kiln) \\
                -o "$out/$1.wasm" "$2" > "$out/$1.txt" 2>&1
        }
        expect() {
            if ! grep -q "$2" "$out/$1.txt"; then
                echo "$1: expected $2 in:" >&2
                cat "$out/$1.txt" >&2
                exit 1
            fi
        }
        refuse() {
            if compile "$1" "$2"; then
                echo "$1 compiled, but must not" >&2
                exit 1
            fi
        }
        refuse not-partial $(location :tests/diagnostics/NotPartial.cs)
        expect not-partial "NotPartial.cs(10,17): error KILN001: Component 'Position' must be a partial, non-generic struct"
        expect not-partial "error KILN003: System 'Loose.Run' must be declared in a partial class"
        refuse cycle $(location :tests/diagnostics/Cycle.cs)
        expect cycle "Cycle.cs(12,17): error KILN010: The \\\\[After\\\\]/\\\\[Before\\\\] ordering of phase Update has a cycle through Systems.A, Systems.B, Systems.C"
        refuse parameters $(location :tests/diagnostics/Parameters.cs)
        expect parameters "error KILN005: Parameter 'text' of system 'Systems.Strange' has type 'string'"
        expect parameters "error KILN007: Parameter 'marked' of system 'Systems.Tagged' is the tag 'Marked'"
        refuse ordering $(location :tests/diagnostics/Ordering.cs)
        expect ordering "error KILN011: System 'Systems.Move' is ordered against 'Draw', which is in phase Render"
        expect ordering "error KILN013: The run condition 'Sometimes' of system 'Systems.Maybe'"
        compile ambiguous $(location :tests/diagnostics/Ambiguous.cs)
        expect ambiguous "Ambiguous.cs(19,17): warning KILN020: Systems 'Systems.Cool' and 'Systems.Warm' of phase Update both use 'Heat'"
        library() {
            mkdir -p "$out/$1"
            $(exe //aseipp/cs2wasm:gameplayc) --library $1 $3 --reference $(location :kiln) \\
                -o "$out/$1/$1.dll" "$2" > "$out/$1.txt" 2>&1
        }
        if library Hidden $(location :tests/diagnostics/Library.cs) "--generator $(location :generator)"; then
            echo "Library.cs compiled, but must not" >&2
            exit 1
        fi
        expect Hidden "Library.cs(13,25): error KILN014: Component 'Secret' of the Kiln library Hidden cannot join a program's schedule: it is not public"
        expect Hidden "error KILN014: System 'Systems.Run' of the Kiln library Hidden cannot join a program's schedule: it is not public"
        library Plain $(location :tests/diagnostics/Library.cs) ""
        if $(exe //aseipp/cs2wasm:gameplayc) --generator $(location :generator) --reference $(location :kiln) --reference "$out/Plain" \\
            -o "$out/unscheduled.wasm" $(location :tests/diagnostics/Unscheduled.cs) > "$out/unscheduled.txt" 2>&1; then
            echo "Unscheduled.cs compiled, but must not" >&2
            exit 1
        fi
        expect unscheduled "error KILN014: Component 'Wheel' of the library Plain cannot join a program's schedule: its library was compiled without Kiln's generator"
        cat "$out"/*.txt
    """,
)

# The platform half: a minimal app on the console SDK, linked with its
# platform component and run under the headless host, which must log its
# coroutine's game time, the Space it is sent, and read back its save.
gameplay.bindings(
    name = "bindings",
    wit = "tilde//aseipp/wlink/demo/sdk:sdk.wit",
    world = "game",
)

gameplay.module(
    name = "smoke",
    srcs = KILN_PLATFORM + [
        "tests/Smoke.cs",
        "tests/SmokeMain.cs",
        ":bindings",
    ],
    alloc_units = 16777216,
    fuel = 1000000,
    generators = [":generator"],
    deps = [":kiln"],
)

gameplay.component(
    name = "smoke-component",
    module = ":smoke",
    wit = ["tilde//aseipp/wlink/demo/sdk:sdk.wit"],
    world = "game",
)

console_link(
    name = "smoke-linked",
    game = ":smoke-component",
    gc = True,
)

console_headless(
    name = "smoke-headless",
    app = "smoke",
    linked = ":smoke-linked",
)

depot.command_test(
    name = "smoke-test",
    script = """
        out=`mktemp -d`
        trap 'rm -rf "$out"' EXIT
        mkdir "$out/save"
        printf '30 space down\\n32 space up\\n' > "$out/script"
        run() {
            $(exe :smoke-headless) --headless --frames 200 --script "$out/script" --save-dir "$out/save"
        }
        first=`run`
        printf '%s\\n' "$first"
        second=`run`
        printf '%s\\n' "$second"
        expect() {
            if ! printf '%s\\n' "$1" | grep -q "$2"; then
                echo "expected: $2" >&2
                exit 1
            fi
        }
        expect "$first" "smoke: runs before 0"
        expect "$second" "smoke: runs before 1"
        expect "$first" "smoke: half a second at tick 30"
        expect "$first" "smoke: space at tick 30"
        expect "$first" "smoke: a second at tick 59, 1 bounces"
        expect "$first" "summary frames=120 presents=120 width=64 height=48 .* exit=0"
        grep -q 'runs=2' "$out/save/smoke/state.txt"
    """,
)
