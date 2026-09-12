# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("//aseipp/cs2wasm:defs.bzl", "gameplay")
load("//aseipp/wlink/demo/sdk:defs.bzl", "console_web")

# The console SDK's own WIT: the world every console game programs against.
SDK = "tilde//aseipp/wlink/demo/sdk"

SDK_WIT = SDK + ":sdk.wit"

# The C# view of console:sdk's `game` world. Functions that need memory
# (strings, lists, records as results) are left out with a comment.
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
# heap, so the module has a platform memory and no game memory, and the
# wasm2c host cannot translate it; the browser host runs it as it is.
depot.genrule(
    name = "breakout-linked",
    out = "linked.wasm",
    cmd = "$(exe tilde//aseipp/wlink:wlink) link -o $OUT " +
          "platform=$(location " + SDK + ":platform.wasm) game=$(location :breakout-component)",
    visibility = ["PUBLIC"],
)

# `buck2 run tilde//aseipp/cs2wasm/examples/console:breakout-console-web-serve`
# serves the console's own browser host with this game.
console_web(
    name = "breakout-console",
    linked = ":breakout-linked",
    module = ":breakout-linked",
    title = "Breakout (C#)",
)

# The console's headless web host plays two seconds and must present every
# frame at the size the game asked for, without a trap or an exit.
depot.command_test(
    name = "console-host-test",
    script = """
        trace=`$(exe tilde//aseipp/wlink/demo/sdk/web:headless) --module $(location :breakout-linked) --headless --frames 120 --trace`
        printf '%s\\n' "$trace" | tail -n 1
        case "$trace" in
            *"summary frames=120 presents=120 width=320 height=240 "*" exit=0"*) ;;
            *) echo "unexpected run under the console host" >&2; exit 1 ;;
        esac
    """,
)

DENO = dict(
    srcs = ["host.mjs"],
    lint_rules_exclude = [
        "no-window",
        "no-window-prefix",
    ],
    permissions = ["all"],
)

depot.deno.run(
    name = "run",
    src = "run.mjs",
    **DENO
)

# The headless host plays a round by steering from the drawn frame.
depot.run_test(
    name = "run-test",
    args = [
        "$(location :breakout)",
        "$(location :breakout-component)",
    ],
    dep = ":run",
)

depot.deno.run(
    name = "terminal-script",
    src = "terminal.mjs",
    **DENO
)

# `buck2 run tilde//aseipp/cs2wasm/examples/console:terminal` plays the game
# in the terminal, as the console's Luau carts do; arrows or A/D move.
depot.command(
    name = "terminal",
    args = ["$(location :breakout)"],
    dep = ":terminal-script",
)

# Sixty scripted frames through the terminal renderer, without a terminal.
depot.run_test(
    name = "terminal-test",
    args = [
        "$(location :breakout)",
        "--frames",
        "60",
    ],
    dep = ":terminal-script",
)

depot.deno.run(
    name = "serve-script",
    src = "serve.mjs",
    **DENO
)

# `buck2 run tilde//aseipp/cs2wasm/examples/console:serve` and open
# http://127.0.0.1:8080 in a browser with Wasm GC.
depot.command(
    name = "serve",
    args = ["$(location :breakout)"],
    dep = ":serve-script",
)
