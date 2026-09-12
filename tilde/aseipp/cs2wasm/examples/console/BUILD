# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("//aseipp/cs2wasm:defs.bzl", "gameplay")
load("//aseipp/wlink/demo/sdk:defs.bzl", "console_headless", "console_link", "console_terminal", "console_web", "console_web_test")

# The console SDK's own WIT: the world every console game programs against.
SDK = "tilde//aseipp/wlink/demo/sdk"

SDK_WIT = SDK + ":sdk.wit"

# The C# view of console:sdk's `game` world: every import, and the `init`
# and `frame` exports as partial methods.
gameplay.bindings(
    name = "bindings",
    wit = SDK_WIT,
    world = "game",
)

# `buck2 build tilde//aseipp/cs2wasm/examples/console:breakout --show-output`
gameplay.module(
    name = "breakout",
    srcs = [
        "Breakout.cs",
        ":bindings",
    ],
    visibility = ["PUBLIC"],
)

# The same game as a component: wit-component checks that its imports and
# exports are exactly the world's.
gameplay.component(
    name = "breakout-component",
    module = ":breakout",
    visibility = ["PUBLIC"],
    wit = [SDK_WIT],
    world = "game",
)

# The game linked with the console's platform component by wlink, the way
# every console game is: one core module whose only imports are the scalar
# HAL, which the console's hosts run. The game keeps its state on the GC
# heap, so the module has a platform memory and no game memory, and runs in
# a Wasm engine only: the browser's, or Deno's for the headless and terminal
# hosts (wasm2c, which the native hosts are built with, has no GC).
console_link(
    name = "breakout-linked",
    game = ":breakout-component",
    gc = True,
)

# `buck2 run tilde//aseipp/cs2wasm/examples/console:breakout-console-web-serve`
# serves the console's own browser host with this game.
console_web(
    name = "breakout-console",
    linked = ":breakout-linked",
    title = "Breakout (C#)",
)

# The console's headless web host plays two seconds of the package and must
# present every frame at the size the game asked for, without a trap or an
# exit. The game module keeps to its size budget: lower it when the module
# shrinks, and explain a raise.
depot.command_test(
    name = "console-host-test",
    script = """
        size=`wc -c < $(location :breakout)`
        if [ "$size" -gt 6935 ]; then
            echo "breakout.wasm is $size bytes, over its budget of 6935" >&2
            exit 1
        fi
        trace=`$(exe :breakout-console-web-headless) --headless --frames 120 --trace`
        printf '%s\\n' "$trace" | tail -n 1
        case "$trace" in
            *"summary frames=120 presents=120 width=320 height=240 "*" exit=0"*) ;;
            *) echo "unexpected run under the console host" >&2; exit 1 ;;
        esac
    """,
)

# A whole round through the console's web core, steering from the drawn
# frame until every brick is cleared, in the served module and in the one
# wlink wrote.
console_web_test(
    name = "steer-test",
    srcs = ["steer_test.ts"],
    env = {
        "BREAKOUT_COMPONENT_WASM": "$(location :breakout-component)",
        "BREAKOUT_LINKED_WASM": "$(location :breakout-linked.wasm)",
        "BREAKOUT_SERVED_WASM": "$(location :breakout-linked-opt.wasm)",
    },
)

# `buck2 run tilde//aseipp/cs2wasm/examples/console:terminal` plays the game
# in the terminal through the console's terminal host; arrows move.
console_terminal(
    name = "terminal",
    app = "breakout",
    linked = ":breakout-linked",
)

# A second through the terminal renderer, without a terminal.
depot.command_test(
    name = "terminal-test",
    script = """
        drawn=`$(exe :terminal) --frames 60 --no-save --seed 1`
        cells=`printf '%s\\n' "$drawn" | grep -o '▀' | wc -l`
        if [ "$cells" -lt 1000 ]; then
            echo "only $cells cells drawn" >&2
            exit 1
        fi
    """,
)

# Fireworks: a show of coroutines (await Frames.NextFrame(), Task.Delay,
# Task.WhenAll) that the frame export advances, linked and played by the
# console's headless host to its end.
gameplay.module(
    name = "fireworks",
    srcs = [
        "Fireworks.cs",
        "FireworksGame.cs",
        ":bindings",
    ],
    visibility = ["PUBLIC"],
)

gameplay.component(
    name = "fireworks-component",
    module = ":fireworks",
    wit = [SDK_WIT],
    world = "game",
)

console_link(
    name = "fireworks-linked",
    game = ":fireworks-component",
    gc = True,
)

console_web(
    name = "fireworks-console",
    linked = ":fireworks-linked",
    title = "Fireworks (C#, async)",
)

# The console's headless host plays the show to its end, a frame at a time:
# the frames it takes are its script's game time (NextFrame, Task.Delay),
# and with Start pressed at frame 40 it skips to the finale once the first
# volley is over.
depot.command_test(
    name = "fireworks-console-host-test",
    script = """
        out=`mktemp -d`
        trap 'rm -rf "$out"' EXIT
        trace=`$(exe :fireworks-console-web-headless) --headless --frames 700 --trace`
        printf '%s\\n' "$trace" | tail -n 1
        case "$trace" in
            *"summary frames=467 presents=467 width=320 height=240 "*" exit=0"*) ;;
            *) echo "unexpected run of the show" >&2; exit 1 ;;
        esac
        drawn=`printf '%s\\n' "$trace" | awk '/^frame=/ { print $2 }' | sort -u | wc -l`
        if [ "$drawn" -lt 300 ]; then
            echo "only $drawn different frames: the show does not move" >&2
            exit 1
        fi
        printf '40 enter down\\n42 enter up\\n' > "$out/skip"
        skipped=`$(exe :fireworks-console-web-headless) --headless --frames 700 --script "$out/skip" --trace | tail -n 1`
        printf '%s\\n' "$skipped"
        case "$skipped" in
            *"summary frames=213 presents=213 "*" exit=0"*) ;;
            *) echo "Start did not skip to the finale" >&2; exit 1 ;;
        esac
    """,
)

# The same show with its async methods compiled as runtime-async methods,
# which the importer splits into steps itself (docs/IMPORTER.md, "Async as
# built"): the same frames, the same skip.
gameplay.module(
    name = "fireworks-runtime-async",
    srcs = [
        "Fireworks.cs",
        "FireworksGame.cs",
        ":bindings",
    ],
    runtime_async = True,
)

gameplay.component(
    name = "fireworks-runtime-async-component",
    module = ":fireworks-runtime-async",
    wit = [SDK_WIT],
    world = "game",
)

console_link(
    name = "fireworks-runtime-async-linked",
    game = ":fireworks-runtime-async-component",
    gc = True,
)

console_headless(
    name = "fireworks-runtime-async-headless",
    app = "fireworks",
    linked = ":fireworks-runtime-async-linked",
)

depot.command_test(
    name = "fireworks-runtime-async-console-host-test",
    script = """
        out=`mktemp -d`
        trap 'rm -rf "$out"' EXIT
        trace=`$(exe :fireworks-runtime-async-headless) --headless --frames 700 --trace`
        printf '%s\\n' "$trace" | tail -n 1
        case "$trace" in
            *"summary frames=467 presents=467 width=320 height=240 "*" exit=0"*) ;;
            *) echo "unexpected run of the show" >&2; exit 1 ;;
        esac
        printf '40 enter down\\n42 enter up\\n' > "$out/skip"
        skipped=`$(exe :fireworks-runtime-async-headless) --headless --frames 700 --script "$out/skip" --trace | tail -n 1`
        printf '%s\\n' "$skipped"
        case "$skipped" in
            *"summary frames=213 presents=213 "*" exit=0"*) ;;
            *) echo "Start did not skip to the finale" >&2; exit 1 ;;
        esac
    """,
)

# The C# view of console:sdk's `async-game` world: the `tasks` it imports
# (waits for frames and the clock as `Task`s, loads as a `StreamReader`)
# and the `main.run` it exports, lifted with a callback.
gameplay.bindings(
    name = "async-bindings",
    wit = SDK_WIT,
    world = "async-game",
)

# The same show as an `async-game`: one long task waiting for each frame
# through the SDK's scheduler, which `console_link(tasks = True)` links
# between it and the platform with the launcher. The component model's
# async between them is wlink's runtime, which the hosts pump.
gameplay.module(
    name = "fireworks-tasks",
    srcs = [
        "Fireworks.cs",
        "FireworksTasks.cs",
        ":async-bindings",
    ],
)

gameplay.component(
    name = "fireworks-tasks-component",
    module = ":fireworks-tasks",
    wit = [SDK_WIT],
    world = "async-game",
)

console_link(
    name = "fireworks-tasks-linked",
    game = ":fireworks-tasks-component",
    gc = True,
    tasks = True,
)

console_web(
    name = "fireworks-tasks-console",
    linked = ":fireworks-tasks-linked",
    title = "Fireworks (C#, async-game)",
)

# The async game draws the frame-pumped show's frames, frame for frame,
# with and without the skip, and ends one frame later, presenting nothing:
# the frame after `run` returns is an async game's last. (Its module has a
# game memory where the frame-pumped one has none: the glue's arena, which
# the subtasks' held memory needs.)
depot.command_test(
    name = "fireworks-tasks-console-host-test",
    script = """
        out=`mktemp -d`
        trap 'rm -rf "$out"' EXIT
        printf '40 enter down\\n42 enter up\\n' > "$out/skip"
        for run in show skip; do
            script=""
            if [ "$run" = skip ]; then script="--script $out/skip"; fi
            $(exe :fireworks-console-web-headless) --headless --frames 700 $script --trace > "$out/$run-game"
            $(exe :fireworks-tasks-console-web-headless) --headless --frames 700 $script --trace > "$out/$run-tasks"
            tail -n 1 "$out/$run-tasks"
            awk '/^frame=/ { print $1, $2 }' "$out/$run-game" > "$out/$run-game-frames"
            frames=`wc -l < "$out/$run-game-frames"`
            awk '/^frame=/ { print $1, $2 }' "$out/$run-tasks" | head -n "$frames" | diff "$out/$run-game-frames" -
        done
        case `tail -n 1 "$out/show-tasks"` in
            *"summary frames=468 presents=467 width=320 height=240 "*" exit=0"*) ;;
            *) echo "unexpected run of the async show" >&2; exit 1 ;;
        esac
        case `tail -n 1 "$out/skip-tasks"` in
            *"summary frames=214 presents=213 "*" exit=0"*) ;;
            *) echo "Start did not skip the async show to the finale" >&2; exit 1 ;;
        esac
    """,
)
