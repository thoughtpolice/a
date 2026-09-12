<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Breakout on the console SDK

Breakout written against `console:sdk`'s `game` world, the WIT world the
console's games program against. Nothing about the host is hard-coded in the
C#: [Breakout.cs](Breakout.cs) implements the world's two exports, `init` and
`frame`, and calls the world's imports through bindings `witgen` generates
from the SDK's own [sdk.wit](../../../wlink/demo/sdk/wit/sdk.wit). The game
keeps every bit of its state in static fields; the host sees only draw calls.

```sh
buck2 test tilde//aseipp/cs2wasm/examples/console:steer-test   # a round, steered
buck2 run tilde//aseipp/cs2wasm/examples/console:terminal      # play in the terminal
buck2 run tilde//aseipp/cs2wasm/examples/console:breakout-console-web-serve
```

The game runs on the console's own hosts, the ones its C, Rust and Luau
games run on, and the page needs a browser with WebAssembly GC. Arrow keys
move the paddle; in the terminal Ctrl-C quits.

## What the build does

[BUILD](BUILD) uses the macros from [defs.bzl](../../defs.bzl) on
`tilde//aseipp/wlink/demo/sdk:sdk.wit`, the file the console's C and Rust
bindings are generated from too:

- `:bindings` runs `witgen csharp` over the SDK for world `game`: every
  interface the world imports, strings, lists, records and resources
  included (`draw-text`, `present`, `read-events`, the `files` resource,
  ...), which cross through the module's canonical memory, and the `init`
  and `frame` exports as partial methods. A module imports only what it
  calls: Breakout draws with the overlay primitives and reads `input.poll`.
- `:breakout` compiles the bindings with `Breakout.cs` into `breakout.wasm`.
- `:breakout-component` wraps it into a component with `witgen componentize`;
  wit-component checks that the module's imports and exports are exactly the
  world's, so this target is also the proof that the module fits the SDK.

## The hosts

`:breakout-linked` links the component with the SDK's platform component
through wlink (`console_link`), exactly as the console's C, Rust and Luau
games are linked: the result is one core module whose only imports are the
scalar HAL, with the platform's memory and no game memory, since the game's
state lives on the GC heap. wasm2c has no GC support, so the module has no
native host; it runs in a Wasm engine, and `console_link` optimizes it with
`wasm-opt -O3` (GC and SIMD enabled) into the module every host runs, which
is a third the size of what wlink wrote. The hosts are the console web
host's, over one core:

- `:breakout-console-web-serve` serves the browser host with the game
  (`console_web`), and `:console-host-test` plays two seconds of that
  package under the headless host.
- `:terminal` (`console_terminal`) plays it in a terminal, as half-block
  cells in 24-bit colour; `:terminal-test` draws a second of it without one.
- `:steer-test` ([steer_test.ts](steer_test.ts), a `console_web_test`)
  plays a whole round through the core's runner. The game does not expose
  its state, so the test steers from the frame it presents: it finds the
  ball and paddle by colour and holds the left or right arrow. It asserts
  the frame size and rate the game asked for, that no frame traps, that
  every frame draws one paddle and at most one ball, that the round ends
  with every brick cleared, and that the finished game keeps drawing; the
  module wlink wrote plays the same round to the same last frame, and the
  component carries the component layer.

```sh
buck2 test tilde//aseipp/cs2wasm/examples/console:console-host-test
buck2 test tilde//aseipp/cs2wasm/examples/console:steer-test
```

## Fireworks: async gameplay

[Fireworks.cs](Fireworks.cs) is a show written with `async` (see
docs/IMPORTER.md, "Async as built"). Each rocket is a coroutine that rises a
step a frame (`await Frames.NextFrame()`) and bursts into sparks that fall and fade frame
by frame; the volleys wait on each other with `Task.WhenAll` and on game time
with `Task.Delay`, and Start skips to the finale through a
`CancellationToken`. The `frame` export advances the frame loop by the
frame's time (`Frames.Advance`), which runs every coroutine that is due
inside the export's call and under its budgets, and then draws; it returns
false once the show is over.

```sh
buck2 test tilde//aseipp/cs2wasm/examples/console:fireworks-console-host-test
buck2 run tilde//aseipp/cs2wasm/examples/console:fireworks-console-web-serve
```

`:fireworks-console-host-test` plays the show's web package under the
console's headless host to its end, which comes after 467 frames (the
script's game time), and again with Start pressed at frame 40, when it skips
to the finale once the first volley is over (213 frames);
`:fireworks-runtime-async-console-host-test` plays the runtime-async build
(`console_headless`) to the same frames.

## Fireworks as an async game

The same show plays as an `async-game`, the SDK's world for a game written
as one long task: [FireworksTasks.cs](FireworksTasks.cs) implements
`Main.Run`, which starts the show and then loops on `await
Tasks.Frames(1)`, stepping it in each frame's turn by the time the clock
says went by. `:async-bindings` is witgen's view of that world: the SDK's
`tasks` as `Task`-returning imports, and `main.run` as a partial method
lifted with a callback. `console_link(tasks = True)` links the game with the
SDK's scheduler and launcher, so the package still exports `init` and
`frame`; the component model's async between the game's task and the
scheduler is wlink's runtime, which the console's hosts pump after each
frame. [FireworksGame.cs](FireworksGame.cs) is the `game` world's entry,
and both share the show in [Fireworks.cs](Fireworks.cs).

```sh
buck2 test tilde//aseipp/cs2wasm/examples/console:fireworks-tasks-console-host-test
buck2 run tilde//aseipp/cs2wasm/examples/console:fireworks-tasks-console-web-serve
```

The test plays both games under the headless host, with and without the
skip, and requires the async one to present the same frames as the frame
export's, hash for hash; it ends a frame later, the frame after `run`
returns, which presents nothing.
