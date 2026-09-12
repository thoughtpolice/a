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
buck2 test tilde//aseipp/cs2wasm/examples/console:run-test   # a headless round
buck2 run tilde//aseipp/cs2wasm/examples/console:terminal    # play in the terminal
buck2 run tilde//aseipp/cs2wasm/examples/console:serve       # then open http://127.0.0.1:8080
```

The page needs a browser with WebAssembly GC. In both, arrow keys or A/D
move the paddle, R restarts, and in the terminal Q quits. The terminal
renderer ([terminal.mjs](terminal.mjs)) writes each frame as half-block
cells in 24-bit colour, sampled nearest-neighbour to the window, and holds a
button for a moment after each key press since a terminal never reports a
release, as the console's native terminal host does. `--fps N` changes the
pace; `--frames N` steers the paddle itself and stops, which is how
`:terminal-test` exercises it without a terminal.

## What the build does

[BUILD](BUILD) uses the macros from [defs.bzl](../../defs.bzl) on
`tilde//aseipp/wlink/demo/sdk:sdk.wit`, the file the console's C and Rust
bindings are generated from too:

- `:bindings` runs `witgen csharp` over the SDK for world `game`. The SDK is
  richer than a gameplay module can reach: every function that takes a string
  or list, or returns a record, is left out with a comment in the generated
  file (`draw-text`, `present`, `read-events`, the whole of `files`, ...).
  What remains is the overlay drawing (`clear`, `fill-rect`, `draw-rect`,
  `draw-line`, `fill-circle`, `set-clip`, `set-camera`), `input.poll` and
  `capabilities`, the clock, `set-mode`, `random-seed` and `exit`.
- `:breakout` compiles the bindings with `Breakout.cs` into `breakout.wasm`.
- `:breakout-component` wraps it into a component with `witgen componentize`;
  wit-component checks that the module's imports and exports are exactly the
  world's, so this target is also the proof that the module fits the SDK.

## The hosts

[host.mjs](host.mjs) implements the scalar part of the world in JavaScript,
keyed by the canonical import names (`console:sdk/gfx@0.1.0`, `fill-rect`),
supplies only what the module imports, and keeps each frame's overlay as a
display list that `rasterize` turns into RGBA pixels. It is the smallest
thing that can run the module, and it shows the boundary plainly.

The console's own hosts run it too. `:breakout-linked` links the component
with the SDK's platform component through wlink, exactly as the console's C,
Rust and Luau games are linked: the result is one core module whose only
imports are the scalar HAL, with the platform's memory and no game memory,
since the game's state lives on the GC heap. `:console-host-test` plays two
seconds of it under the console's headless web host, and
`:breakout-console-web-serve` serves the console's browser host with it:

```sh
buck2 test tilde//aseipp/cs2wasm/examples/console:console-host-test
buck2 run tilde//aseipp/cs2wasm/examples/console:breakout-console-web-serve
```

The wasm2c path is not available to it: wasm2c has no GC support, so the
console's own terminal host and the native parity tests stay with the
linear-memory games; `:terminal` above renders through this example's host
instead.

[run.mjs](run.mjs) plays a round headlessly. The game does not expose its
state, so the runner steers from the frame it is given: it finds the ball and
paddle by colour in the display list and holds left or right. It asserts the
frame size and rate the game asked for, that no frame faults, that the round
ends with every brick cleared, that the finished game keeps drawing, and that
the component carries the component layer. [app.mjs](app.mjs) is the browser
version of the same loop, and [serve.mjs](serve.mjs) serves it.
