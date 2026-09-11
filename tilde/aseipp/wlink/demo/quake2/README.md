<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Quake II on the console SDK

Run the Quake II demo, played with the keyboard and the mouse and software
rendered at 320x240, in a Linux terminal:

```sh
buck/bin/buck2 run tilde//aseipp/wlink/demo:quake2
```

Buck fetches id's 3.14 demo installer, takes the game data out of it, and
builds the application. The default opens the main menu; to go straight into
the first level:

```sh
buck/bin/buck2 run tilde//aseipp/wlink/demo:quake2 -- -- +map demo1
```

The first `--` belongs to Buck, the second separates host options from the
engine's own arguments, which accept every `+set` and `+command` the engine
knows; with no command of your own the menu opens. Host options are the runner's: `--pak PATH` selects the data, and
retail `pak0.pak` works in place of the demo's; `--renderer auto|kitty|ansi`,
`--headless --frames N`, `--script PATH`, `--trace`, and `--dump-frame PATH`
behave as for Doom. The demo has three levels, `demo1` to `demo3`.

| Control | Action |
| --- | --- |
| W / S | Forward / backward |
| A / D | Strafe left / right |
| Mouse | Aim |
| Left / right arrows | Turn |
| Space, left mouse | Fire |
| E / C | Jump / crouch |
| 1–9 | Select weapon |
| Tab, [ and ], Enter | Inventory |
| Escape, arrows, Enter | Menus |
| ` | Console |
| Ctrl-C | Quit the host |

The engine's `default.cfg` supplies the rest of the bindings, and a terminal
with kitty keyboard support is needed for simultaneous held keys. The console
turns the engine's `freelook` on, which its own default leaves off: stock
Quake II aims up and down only while a `+mlook` key is held, a command this
engine never registers, and the mouse walks the player instead of raising the
view. `-- +set freelook 0` puts the 1997 behaviour back.

The same build also runs in a browser, where the pointer locks for mouse look:

```sh
buck/bin/buck2 run tilde//aseipp/wlink/demo/quake2:quake2-web-serve
```

That serves a 51 MB package holding the browser host, the linked module and the
pak at `baseq2/pak0.pak`; `?arg=%2Bmap&arg=demo1` goes straight into the first
level. Because the package carries a copy of the pak, it is never uploaded to a
shared cache, as the pak itself is not. `:quake2-web-headless` replays it with
the native runner's options, and `:test-quake2-e2e-web` and
`:test-quake2-web-parity` hold it to the native runner's own results. See the
[SDK guide](../sdk/README.md) for the browser host and
[the demo README](../README.md) for the query parameters.

## What the port is

The engine is [quake2generic](https://github.com/ozkl/quake2generic), ozkl's
platform-neutral form of id Software's Quake II source release: the client,
server, game module, and software renderer statically linked behind a few
platform hooks. `:quake2generic` fetches
[a fork](https://github.com/thoughtpolice/quake2generic) at commit
`6608a8beae5cb1d52acc0875c54088f7a049daf6` (SHA-256
`c3ff4a36a30d91e59833ae2528dc3d989972b0e7e9426743ed9c772d21ea7ce6`), which
is ozkl's `84f34ed` plus a commit fixing two functions whose definitions
disagreed with their declarations, and one making the 8-bit mixer scale
channels by `snd_scaletable[volume >> 3]` rather than id's original `>> 11`,
which always picked the zero row; native builds tolerate the former and
WebAssembly's indirect-call signature check does not.

`:engine` compiles the C-only static set from the upstream Makefile for
wasm32 against the [SDK libc](../sdk/README.md). `shim.c` is the platform:
the software renderer's window becomes an 8-bit framebuffer expanded through
the palette into `gfx.present`, the clock and keyboard come from the SDK, and
the process ends through it. `hunk.c` replaces the engine's model allocator
with one that returns each model's unused reservation, so a level costs what
its models weigh rather than the 16 MiB per map and 2 MiB per model the
engine asks for. `host.c` mounts the pak where the engine looks for it.

The menu's dimmed background is the software renderer's checkerboard fade,
which reads as black stripes and dots once the pixels are scaled up.

Single-player video and keyboard input are supported; `sound.c` drives the
engine's mixer through the SDK's audio queue, handing each painted stretch of
the DMA ring to the platform and reporting the position the platform has not
yet played. The mouse aims and fires, at
four engine units per frame pixel; the terminal cannot lock the pointer, so
aiming stops at the edge of the window, while the browser locks it and does
not. `:test-quake2-e2e` scripts pointer motion and holds the engine to
changing the player's pitch and yaw without moving the player. Networking is not enabled. Errors the engine recovers from by abandoning a frame do recover: the libc
lowers `setjmp` and `longjmp` onto WebAssembly's exception mechanism, so
`Com_Error` unwinds to the frame loop the way it does natively.
`:test-quake2-error-recovery` asks for a demo that is not there and holds the
engine to reporting it, shutting the server down, and running its remaining
frames. Saving and loading work, quick saves on F6
and F9 included: `system.c` implements the engine's directory search over the
SDK's listing, which the save system uses to copy and wipe slots, and refreshes
the server's client edicts after a game is read, since the SDK's allocator does
not hand the entities back at the address the original relied on.
Configuration and saves persist under the runner's save directory in the
terminal (`~/.local/share/console/quake2` unless `--save-dir` says otherwise)
and last for the session when headless.

## Data and licences

The engine is under the GNU General Public License, version 2 or later;
`LICENSE` and `gnu.txt` in the archive carry the text and id's notices, and
`readme.txt` is id's release note.

The only freely redistributable Quake II data is id's 3.14 demo installer,
and only as that unmodified file: its `license.txt`, kept next to the
extracted pak as `:demo-data[license]`, permits distributing the installer by
electronic means and nothing else. `:demo-installer` pins the file by hash,
`extract_pak.py` takes `pak0.pak` out of it at build time and appends the
player models the installer ships loose beside the pak, and the result stays
out of shared build caches. The retail game data remains copyrighted by id
Software and is not part of this repository.

## Tests

`buck2 test tilde//aseipp/wlink/demo/quake2/...` runs the hunk allocator's
native test, the imports check (the game imports only the SDK, the linked
module only the HAL), and the end-to-end test, which drives the headless
runner through `demo1`: movement, turning, and firing from a script, key
releases, deterministic frames, parity between the instrumented test build
and the production build, the player models, and memory stability over 1,500
frames. `tilde//aseipp/wedge:console-tests` runs the linked module under the
wedge interpreter against the same runner, and `wlink-quake2.test` checks the
module's shape.
