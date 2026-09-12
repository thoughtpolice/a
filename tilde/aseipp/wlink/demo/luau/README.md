<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Luau console

A fantasy console on the SDK: [Luau](https://luau.org) compiled to wasm32,
a small API over `console:sdk` in the interpreter, and a prelude that gives a
cart the short names a console is written in. A cart is one `.luau` file, and
the console is the same program whichever cart it runs.

The display is 256 by 256 with a fixed sixteen colour palette. That is the
resolution the art is drawn at rather than a window size, so a cart draws the
same picture however large the terminal or browser showing it is. The d-pad is the
arrow keys, `A` and `B` are <kbd>Z</kbd> and <kbd>X</kbd>, start is
<kbd>enter</kbd> and select is <kbd>shift</kbd>.

## Running a cart

```console
$ cd tilde/aseipp/wlink/demo/luau
$ buck2 run :luau -- carts/tetris.luau
$ buck2 run :tetris                     # the same cart, by name
```

The runner compiles the cart on the way in: a `.luau` is compiled by the Luau
compiler built for the host, a `.luauc` is mounted as it is, and with no cart
at all the console comes up on its own splash. `--headless --frames N` plays
without a terminal, `--script` replays recorded input, and `--dump-frame`
writes the last frame as a PPM.

A browser gets the same console with the cart mounted where the runtime looks
for one:

```console
$ buck2 run :tetris-web-serve
```

## Writing a cart

A cart defines up to three globals. All are optional: a cart with only `_draw`
is a still image that reads input, and one with only `_update` draws nothing.

| Global | When it runs |
| --- | --- |
| `_init()` | Once, before the first frame. |
| `_update(dt)` | Once a frame, `dt` in seconds. |
| `_draw()` | Once a frame, after `_update`. |

Setting `__console_quit = true` ends the run at the end of the frame.

### Drawing

Colours are palette indices, 0 to 15, and coordinates are display pixels
shifted by the camera.

| Call | What it does |
| --- | --- |
| `cls(color)` | Fills the display; black without an argument. |
| `rectfill(x, y, w, h, color)` | A solid rectangle. |
| `rect(x, y, w, h, color)` | Its outline. |
| `line(x0, y0, x1, y1, color)` | A line. |
| `circfill(cx, cy, radius, color)` | A solid circle. |
| `text(message, x, y, color)` | The built-in 5 by 7 font, 6 pixels a character; lowercase draws as capitals. |
| `camera(dx, dy)` | Shifts everything drawn after it. |
| `clip(x, y, w, h)` | Drops drawing outside a rectangle; `clip()` takes it off. |

### Sprites and tilesets

A sheet is an image the platform keeps. Its art is written as rows of
characters -- a hex digit is a palette index and anything else, a dot reading
best, leaves the pixel clear -- or as a list of tiles, each written out on its
own and laid side by side:

```lua
local ship = sheet({ "..8..", ".888.", "88888", ".9.9." })
local blocks = sheet({ RED_TILE, BLUE_TILE, GREEN_TILE }, 6, 6)
```

The tile size makes a sheet a tileset, its tiles numbered from zero, left to
right and top to bottom.

| Call | What it does |
| --- | --- |
| `sheet(art, tile_w, tile_h)` | Builds one; the tile size is optional. |
| `sheet:spr(tile, x, y, flip_x, flip_y)` | Draws one tile. |
| `sheet:blit(sx, sy, sw, sh, x, y, flip_x, flip_y)` | Draws any rectangle of it. |
| `sheet:map(rows, x, y)` | Draws a tilemap written the way art is, a digit per tile. |

Because the art is only strings, a cart can make it: `carts/tetris.luau`
shades one block per piece colour at load time, and `carts/fighter.luau`
writes its fighter once with `g` and `t` standing in for the gi and its trim
and dresses the same poses twice.

### Input, time and randomness

| Call | What it gives |
| --- | --- |
| `btn(button)` | Whether a button is down; the whole mask with no argument. |
| `btnp(button)` | Whether it went down this frame. |
| `mouse()` | `x, y, buttons`. |
| `frame()` | Frames ended so far. |
| `time()` | Seconds since the console started. |
| `BUTTON` | `UP`, `DOWN`, `LEFT`, `RIGHT`, `A`, `B`, `START`, `SELECT`. |
| `SCREEN_WIDTH`, `SCREEN_HEIGHT` | The display. |

`math.random` is seeded from the console rather than the clock, so a run is as
repeatable as the host it runs on: a headless host derives its seed from the
`--seed` option and replays the same game every time. That is what lets a cart
be tested against the hash of the frames it produces.

## The carts

| Cart | What it is |
| --- | --- |
| `breakout.luau` | A paddle, a ball and a wall, in primitives only. |
| `tetris.luau` | Seven pieces that turn inside their box, a ghost, line clears and levels. Its blocks are a tileset the cart shades for itself. |
| `shmup.luau` | A vertical shooter: sixteen pixel ships, two frames to each, parallax stars, and waves that lean on the player. |
| `fighter.luau` | One round against the console: seven poses at thirty-two by forty-eight, flipped by facing, with startup and active frames on every attack. |
| `splash.luau` | What the console shows with no cart loaded. |

## How it is built

| Target | What it is |
| --- | --- |
| `:vm` | The interpreter for wasm32. No native code generator: it emits machine code for architectures the console does not run on. |
| `:compiler` | The Ast, Bytecode and Compiler libraries for the host. They report errors by throwing, which the console cannot do. |
| `:compile-cart` | Source to bytecode, at build time. |
| `:cart-runner` | The console itself: `runtime.cpp` drives the cart, `console_api.cpp` binds the SDK, and the prelude is compiled into it. |
| `:luau` | The runner with the Luau compiler linked in, so a cart is compiled at startup. |

## Errors

A cart's errors behave the way they do anywhere else: `pcall` catches one and
the cart carries on. The interpreter raises errors by jumping, and the SDK's
libc lowers a jump onto WebAssembly's exception mechanism, so there is nothing
special about this target any more.

An error the cart does not handle is reported against the line that raised it,
with the frames that led there, and the console stops the cart rather than
calling it again every frame:

```
cart: _update: cart:38: attempt to index nil with 'field'
cart:38 function _update
```

## What the console does not do

- **The compiler stays on the host.** A cart is compiled before it reaches the
  console, either at build time or by the runner. The interpreter is what runs
  in the guest; putting the compiler there as well is possible now that C++
  exceptions work, and is not done yet.

## Tests

`:test-vm` runs the interpreter as a guest: states, loading, errors and the
collector. `:test-errors` plays a cart that fails on purpose, both where it
protects itself and where it does not. Every cart has a recorded run pinned to the hash of the frames it
produces -- `:test-tetris` and the rest -- and `:test-<cart>-web-parity` plays
the same run through the native runner and the browser host and holds every
traced frame and the summary to being identical.
