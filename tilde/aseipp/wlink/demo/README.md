<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Console SDK and PureDOOM

Run a playable, keyboard-controlled Freedoom game in a Linux terminal:

```sh
buck/bin/buck2 run tilde//aseipp/wlink/demo:doom
```

Buck fetches the pinned Freedoom 0.13.0 assets and builds the application.
The default starts at the title screen; use the menu to start a game, or
jump into the first level:

```sh
buck/bin/buck2 run tilde//aseipp/wlink/demo:doom -- -- -warp 1 -skill 3
```

The first `--` belongs to Buck. The second separates host options from Doom's
arguments. Host options include `--iwad PATH`, `--renderer auto|kitty|ansi`,
and `--dump-frame PATH` (a PPM capture on exit). The launcher supplies Freedoom
Phase 2 by default; a later `--iwad` overrides it. The host recognizes Doom II,
Ultimate Doom, registered Doom, and shareware IWADs from their level markers.

| Control | Action |
| --- | --- |
| W / S | Forward / backward |
| A / D | Strafe left / right |
| Left / right arrows | Turn |
| Space | Fire |
| E | Use / open doors |
| 1–7 | Select weapon |
| Shift | Run |
| Escape, arrows, Enter | Menus |
| Ctrl-C | Quit the host |

Graphics and keyboard support are detected independently. Kitty graphics
uses full pixel images; the fallback renders truecolor half-block characters.
Both preserve the original 4:3 display aspect and follow terminal resizing.
Kitty keyboard reporting provides simultaneous held keys and real releases.
Legacy terminal input approximates releases after 180 ms without a repeat, so
movement can pause before the terminal's first repeat. Use a terminal with
Kitty keyboard support for precise controls. Terminal modes and images are
restored on exit, signals, and guest traps.

This port supports single-player video (the engine's indexed frame goes to
the platform with its palette), keyboard and mouse input (turning and the
three buttons), and sound effects through the SDK's audio queue.
Music (PureDOOM emits MIDI messages) and networking are not enabled. Configuration and saves live in the runner's
save directory in the terminal and in memory for a headless session; the IWAD
is read-only. Existing engine limits still apply to maps and saves.

[Quake II](quake2/README.md) runs on the same SDK from the same runner:
`buck2 run tilde//aseipp/wlink/demo:quake2`.

## Play in the browser

The same linked application also runs in a browser, against a host written in
TypeScript that binds to the raw HAL directly. Build the package and serve it:

```sh
buck/bin/buck2 build tilde//aseipp/wlink/demo:doom-web --show-output
buck/bin/buck2 run tilde//aseipp/wlink/demo:doom-web-serve
```

The second prints a URL to open; `-- --port 9000` chooses the port. A package
is a plain directory: `index.html`, `console.js` (the host), `worklet.js` (the
audio thread), `linked.wasm`, the application's assets at the virtual paths the
guest opens them by, and `manifest.json` describing the rest. `:game-web`
(the rectangle demo, no assets) and `:sdk-contract-web` are packaged the same
way, and [Quake II](quake2/README.md) has `:quake2-web`.

| Query parameter | Effect |
| --- | --- |
| `?arg=-warp&arg=1` | Guest arguments, replacing the manifest's |
| `?renderer=webgpu` or `?renderer=canvas2d` | Forces a renderer; the default prefers WebGPU and falls back |
| `?nosave` | Keeps what the game writes in memory for the session |
| `?autostart` | Skips the click, for a scripted screenshot; audio still waits for one |

Controls are the terminal's, on the focused canvas: `event.code` names the
physical key, so the layout does not matter, Alt+Enter toggles fullscreen, and
a game that asks to capture the pointer gets it on the next click. What the
game writes lives in IndexedDB under its own name and survives a reload.

The same package replays headlessly, with the native runner's options and
output, which is how the browser host is tested:

```sh
buck/bin/buck2 run tilde//aseipp/wlink/demo:doom-web-headless -- \
  --headless --frames 280 --trace -- -warp 1 -skill 3
```

A browser needs multi-memory WebAssembly for the linked module's three
memories: Chrome 120, Firefox 125, Safari 18 or newer. Older browsers fail at
instantiation and say so. WebGPU is optional.

## Component architecture

```text
PureDOOM.h + C shim + generated C bindings + SDK runtime
                      │ freestanding wasm32
                      ▼
                game component
                      │ console:sdk
                      ▼
              platform component
                      │ console:hal
                      ▼
     wlink → core wasm → wasm2c → native HAL + wasm-rt
```

Buck downloads `PureDOOM.h` from a pinned upstream commit and verifies its
SHA-256 before exposing it to the shim. Only `DOOM_IMPLEMENTATION` is enabled;
the engine has no host libc or WASI dependency. The [SDK](sdk/README.md) owns
the reusable C/Rust component build rules, allocator, seekable streams, platform
implementation, terminal runner, and rendering/input support. Doom contributes
the engine shim and the native IWAD mounting policy.

The SDK generates C headers/import wrappers and Rust traits from
[`sdk/wit/`](sdk/wit/), using pinned upstream `wit-bindgen`. The platform and
original Rust demo implement these generated traits. Native hosts use generated
HAL record declarations and a generated header that gives readable names to
wasm2c's declarations. Canonical signatures and key enums are not duplicated in
the application sources. See the SDK guide for adding another application.

The shared WIT package retains the rectangle/text/button demo and adds:

| Interface | Contract |
| --- | --- |
| `gfx.present` | Tightly packed RGBA8 with width and height; invalid dimensions or byte counts are discarded |
| `input.read-events` | Ordered named-key events with pressed/released state |
| `clock.now-ms` | Elapsed milliseconds, constant during a frame |
| `files` | A `file` resource; open, size, positional read/write, and closing by dropping the handle |
| `process` | Argument count/indexed string access and non-returning exit |

`sdk/console.h` exposes convenience wrappers around the generated C bindings.
`sdk/runtime.h` supplies application callbacks and allocation;
`sdk/stream.h` adds independent seek/EOF state over positional file resources.
Returned strings, byte buffers, and
event arrays belong to the caller and must be released with their matching
free helper. A file is a resource the caller owns: `open` yields one or
reports failure, size and write return `-1` on failure, a read returns
`{status, data}` with status `0` on success, including EOF, or `-1` on
failure, and closing the handle closes the file. Write opens create/truncate
a file. The linker keeps the handles in a table of its own; the native host
only ever sees the HAL's numeric file handles.

The SDK's native HAL owns mounted assets, file handles, session files, input
queue and latest frame. Applications configure their frame rate and asset
mounting; the runner also supports applications without assets. It implements
canonical returned buffers using the specific
import's exported memory and allocator, reacquiring memory after allocation.
The platform validates/translates data and frees canonical buffers with
post-return callbacks. Only HAL imports remain after linking; native code
contains no Doom engine implementation.

## Headless execution and tests

```sh
buck/bin/buck2 run tilde//aseipp/wlink/demo:doom -- \
  --headless --frames 280 --dump-frame /tmp/doom.ppm -- -warp 1 -skill 3

buck/bin/buck2 test 'tilde//aseipp/wlink/demo/...'
```

Headless time advances deterministically at 35 Hz without sleeping. `--trace`
prints frame hashes and both components' memory sizes. `--script PATH` reads
sorted frame/key transitions, for example:

```text
100 w down
130 w up
140 right down
170 right up
180 space down
220 space up
```

Frame zero events are available during initialization. Keys include lowercase
letters, digits, `space`, `enter`, `escape`, arrows, modifiers, `f1`–`f12`, and
`pause`. The final summary reports frame count, presentations, image size,
RGBA FNV-1a hash, memory sizes, and exit status.

The browser host replays the same suites through `:test-doom-e2e-web` and
`:test-sdk-contract-web`, and `:test-doom-web-parity` runs one module through
both hosts and requires every `frame=` line and the summary to be identical.

Tests cover the real linked application in MAP01, movement/turning/firing and
releases, repeatable frames, production/test parity, and 2,100 frames of stable
memory. An independent SDK guest checks large transfers and memory growth,
file operations, streams, allocation reuse, ownership, clock, input, invalid
frames, exit and traps. A separate host smoke test starts without assets.
Native and pseudo-terminal tests exercise rendering, protocol negotiation,
fragmented input, resizing, signals, and restoration. The original rectangle
demo remains available as `:host` and retains its deterministic tests.

Freedoom's `COPYING.txt`, `CREDITS.txt`, and `CREDITS-MUSIC.txt` are retained in
the downloaded asset target. PureDOOM's source provenance is recorded in
`doom/README.md`; the downloaded header retains its upstream notices.
