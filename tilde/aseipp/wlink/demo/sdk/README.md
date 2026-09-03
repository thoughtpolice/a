<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Console SDK

The SDK builds C and Rust games against `console:sdk`, implements that interface
over `console:hal`, and links both halves into one core Wasm module. Portable
guest code lives alongside the WIT interfaces; `host/` contains the native
terminal runner (for Linux and macOS), which runs the module translated to C by
wasm2c, and `web/` is a host in TypeScript that binds to the same raw HAL
through `WebAssembly.instantiate` and needs no component tooling: in the
browser, and headless or in a terminal under Deno. Every host runs the same
optimized module, the browser in its own Wasm engine.

## Building an application

For a freestanding C game, load the SDK macro in its `BUILD`:

```python
load("tilde//aseipp/wlink/demo/sdk:defs.bzl", "console_application")

console_application(
    name = "my-game",
    srcs = ["game.c"],
    host_srcs = ["host.c"],
)
```

The guest includes `console.h` and `runtime.h`, then implements
`void console_guest_init(void)` and `int32_t console_guest_frame(uint32_t dt_ms)`.
A nonzero frame result continues execution. The macro supplies generated C
bindings, allocation, streams, and the minimal C support needed by the bindings.
It builds `:my-game.wasm`, `:my-game-linked.wasm`, and `:my-game-host` through the
wasm32 compiler, componentizer, wlink, and wasm2c. Optional `headers`,
`compiler_flags`, and `initial_memory` customize the guest; host sources compile
for the native target.

`console_web` packages a linked application for a browser: it lays out the
browser host's bundle, the linked module and every mounted asset at its virtual
path, with a manifest describing the frame rate, the aspect, the guest
arguments and the runner option that replaces the single mount.

```python
load("tilde//aseipp/wlink/demo/sdk:defs.bzl", "console_web")

console_web(
    name = "my-game",
    frames_per_second = 35,
    linked = ":my-game-linked",
    mounts = {"assets.pak": "//path/to:assets"},
    option = "pak",
    title = "My Game",
)
```

`aspect` says what shape the frame takes in the page. `4:3` is the terminal's
box, for a game whose pixels were never square; `frame` is the frame's own
ratio scaled by whole numbers, which keeps the pixels of a cart drawn a pixel
at a time even; and `fill` is the frame's own ratio at whatever scale fits,
for a frame already near the screen's own resolution, where a whole multiple
would round 1.9 down to 1 and leave most of the canvas black. `fill` also
says the frame is not pixel art, so both renderers filter it rather than
taking the nearest pixel, which is what a scale that is not a whole number
needs and what pixel art must not have.

It declares `:my-game-web` (the directory), `:my-game-web-serve` (a static
server to open it with), `:my-game-web-headless` (the same package replayed
with the native runner's options and output) and a test that checks the built
package against its inputs.

`console_link(name, game)` links a game component with the platform:
`:<name>.wasm` is what wlink wrote, `:<name>-opt.wasm` the module after
`wasm-opt -O3`, which is what every host runs (the browser is served it and
wasm2c translates it), and `:<name>-c` the translation the native hosts are
built from. A game compiled to the garbage-collected heap, as every game
gameplayc (a C# compiler) compiles is, passes `gc = True`: its module is
optimized with GC and SIMD enabled and gets no translation, since wasm2c has
neither, so it runs in a Wasm engine only. Those hosts are macros too, over
the linked module: `console_terminal(name, linked, app)` plays it in a
terminal (`app` names its save directory), `console_headless(name, linked,
app)` is the headless runner for a module that has no package, and
`console_web_test(name, srcs, env)` is a Deno test whose sources import the
web core (`sdk/web/runner.ts` and the rest) by their path in the repository,
for a test that plays a game through the same runner, frame by frame.

Rust games use `console_rust_component(name, src)`, implementing the generated
`bindings::Guest` trait and calling `bindings::export!(Game with_types_in bindings)`.
The macro supplies `mod bindings;` and `mod runtime;` source files. Compose the
result with `console_link(name = "linked", game = ":game.wasm")`, then
`console_host(name = "host", linked = ":linked", srcs = ["host.c"])`.
The original game in `../game/src/main.rs` is a complete example.

The native application chooses its settings through `host.h`. An application
without external assets needs only:

```c
#include "host.h"

int main(int argc, char **argv) {
  const console_host_config config = {.name = "my-game"};
  return console_host_run(&config, argc, argv);
}
```

The default rate is 60 Hz. Set `frames_per_second` to override it. Applications
that need assets can provide `asset_option`, `asset_required`, and `mount_asset`;
the callback mounts data using `console_host_mount_readonly`. Ownership of asset
bytes transfers to the runner only on a successful mount. The guest sees virtual
paths in a virtual root, not host paths. With no asset option, startup requires no host file.
The runner supplies terminal/headless execution, frame capture, scripted input,
a writable virtual root, and cleanup after exit, signals, or traps. The
application's clock advances one frame period per frame in every mode, so a
run is a function of its inputs: `--script PATH` feeds sorted
`frame key down|up` lines (keys are named `a`..`z`, `0`..`9`, `f1`..`f12`,
`tab`, `enter`, `escape`, `space`, `backspace`, the arrows, `shift`, `control`,
`alt`, `pause`, and the other keys by their WIT names such as `minus`,
`left-bracket`, `page-up`, and `kp-enter`), `frame mouse x y buttons wheel`
lines placing the pointer in frame pixels with the held buttons (the
`mouse-buttons` bits) and the wheel notches turned that frame, and
`frame text ...` lines of typed text; `--record PATH` writes everything the
application received in the same format, so a terminal session can be
replayed headless.
In the terminal the frames are paced against the wall clock; a slow frame is
followed by catch-up frames, and a backlog past a quarter second is dropped
rather than made up. Sound is a queue of interleaved signed 16-bit stereo
frames at 44100 Hz (`audio.format`, `write`, `queued`): the host plays a
frame period's worth after every frame, in every mode, so the played stream
is part of what makes a run deterministic, and `--trace` and the summary
report its running hash and frame count next to the video hash. In the
terminal the stream goes to the first of `pw-cat`, `aplay`, SoX's `play`, or
`ffplay` that is installed, through a pipe that never blocks the frame loop
(`--no-audio` skips the player); `--dump-audio PATH` writes everything
played, silence included, as a WAV file. In the terminal, what the
application writes persists under
`$XDG_DATA_HOME/console/<name>` (`~/.local/share` by default); `--save-dir PATH`
chooses the directory and `--no-save` keeps the session's files in memory.
Headless runs keep them in memory unless `--save-dir` is given, so tests stay
hermetic and can start from a prepared directory. Every file and directory
below the save directory is loaded at startup, below the read-only asset
mounts, and each change is written back as it is made or closed.
Its terminal frontend displays `gfx.present` framebuffers at 4:3, dropping
frames while a slow terminal is still absorbing earlier ones so the
application keeps its pace. `input.capabilities` reports `key-releases` when
releases are real: always when headless, and in the terminal when the kitty
keyboard protocol is in use; otherwise the decoder synthesizes a release
shortly after each press. It always reports `text` and `mouse`: typed text
comes from the kitty protocol's associated text, or the key's own character
without it, and the pointer from SGR mouse reports (any-motion tracking, in
pixels when the terminal also spoke the graphics protocol), mapped onto the
presented frame; `capture-pointer` is refused, since a terminal cannot hide
or lock the pointer, so `mouse.dx` stops at the edge of the window.

A frame has two layers. The game may present a whole image from its own
renderer, as RGBA8 (`gfx.present`) or as one byte per pixel through a
256-entry palette (`gfx.set-palette`, `gfx.present-indexed`), which the host
expands natively; and it may draw an overlay with the primitives
(`clear`, `fill-rect`, `draw-rect`, `draw-line`, `fill-circle`, `draw-text`
in the built-in 5x7 font, `draw-sprite` from a `sheet` resource, under
`set-clip` and `set-camera`). The platform rasterizes the overlay onto the
presented image, or onto a blank display-sized frame for a game that never
presents, when the host calls the platform's `end-frame` export after every
game frame; a frame with no overlay reaches the host as the game gave it.
The rectangle example's `poll` buttons come from the keyboard: the arrows,
Z and X, enter, and shift.

During `init` a game may ask for its frame rate (`clock.set-frame-rate`, 1
to 1000 Hz, honoured before the first frame) and the size of the blank frame
it draws on (`gfx.set-mode`, up to 4096 a side); `gfx.info` reports both.
`clock.frame` counts the frames ended so far and `clock.unix-seconds` is the
wall clock, fixed at `--unix-time` (zero by default) when headless.
`system.info` names the host (`terminal`, `headless`, `web`, or the
interpreter's `interpreter`) and says whether files written outlast the session;
`system.random-seed` is entropy from the host, or `--seed` when headless, so
a run that seeds its generator from it stays reproducible; `system.set-title`
names the terminal tab, whose previous title comes back on exit.

## Async games

A game may instead be one long task. Its world is `async-game`: it imports
`console:sdk/tasks` besides the rest, and exports `console:sdk/main`, whose
`run` the SDK starts once before the first frame; the game is over when
`run` returns. `tasks.frames(n)` returns once `n` more frames have begun,
`tasks.sleep(ms)` in the first frame to begin that many milliseconds of the
application's clock later, and `tasks.load(path)` streams a file's bytes, 64
KiB of them a frame at most, as far as the game has read. A game has any
number of these in flight at once, and cancels a wait as any subtask.

`console_link(..., tasks = True)` puts two SDK components between such a game
and the platform. The scheduler implements `tasks` over the platform's clock
and files; the launcher starts `run` and exports the `init` and `frame` every
console package has, so a host drives an async game as it drives any other.
What such a package adds is wlink's async runtime, and every SDK host pumps
it (`wlink:async:pump`, until it returns 0) after `init` and after each
`frame`, before `end-frame`: `frame` begins a frame, which wakes the tasks
whose waits are over, and the game draws that frame in its turn during the
pump. The frame after `run` returns is the last. When the runtime traps,
the host reports its reason too, the code from wlink's `ASYNC.md`. A
package without an async game has no runtime and links exactly as before.

`console_task_component(name, srcs)` builds an async game in C against the
generated callback-style bindings (`async_game.h`:
`exports_console_sdk_main_run` and its callback, the subtask, waitable set
and stream helpers). It links the SDK's small C support in `tasks/`
(allocation and the string routines the bindings call) instead of the SDK's
libc, which is bound to the `game` world; the scheduler and the launcher are
built the same way. [`tasks/contract_test.c`](tasks/contract_test.c) is the
example, and `tasks:test-contract` runs it under the native runner and the
web core and requires the same schedule, frame for frame, from both. A Rust
game needs wit-bindgen's async runtime for its bindings, which the SDK does
not carry yet.

## Generated interfaces

[`wit/sdk.wit`](wit/sdk.wit) defines the game API; [`wit/hal.wit`](wit/hal.wit)
defines the platform's host requirements. Edit these sources rather than generated
declarations. The guests' bindings come from wit-bindgen's own generators, which
[witgen](../../../witgen/README.md) runs in the build graph (`witgen c`,
`witgen rust`):

| Target under `tilde//aseipp/wlink/demo/sdk/bindings` | Output/use |
| --- | --- |
| `:game-c[h]`, `:game-c[c]` | Guest C header and import/export wrappers |
| `:game-rust` | Rust game imports and `Guest` trait |
| `:platform-rust` | Rust HAL imports and SDK implementation traits |
| `:async-game-c[h]`, `:async-game-c[c]` | An async game's callback-style C bindings |
| `:scheduler-c`, `:launcher-c` | The SDK's own components for async games |

The hosts' side of the HAL comes from [witgen](../../../witgen/README.md),
under wlink's host ABI: each host implements the HAL's functions with typed
values, and the bindings lift the arguments out of the platform's memory and
copy the results into it through the import's allocator.

| Target | Output/use |
| --- | --- |
| `:hal-bindings-c` | `hal-bindings.h`: what the native hosts implement, and the imports wasm2c's module calls |
| `web/hal_bindings.ts` | The browser host's `Raw` and `bindRaw`, checked in; `web:test-hal-bindings` keeps it current |

`console_link` also generates `linked.h` with wasm2c and `hal-host.h` from its
annotated declarations. The latter aliases the actual import, memory, and
allocator symbols to the names `hal-bindings.h` defines and calls; host code
does not maintain a separate wasm2c name mangler. A function added to
`wit/hal.wit` is one each host implements, which its compiler asks for.
Generated output stays in Buck's output tree, but for the browser host's.

## Ownership and runtime support

`console.h` wraps the generated C API in convenient pointer/length descriptors.
Returned bytes, strings, and events belong to the caller: release them with
`console_free_bytes`, `console_free_string`, or `console_input_free_events`.
The helpers accept empty values and clear the descriptors. A `console_file` is
the `files` interface's `file` resource: `console_files_open` hands one out,
the `console_file_*` methods borrow it, and `console_file_close` drops it,
which is what closes the file on the platform side. The virtual root has
directories: `console_files_list_directory` returns the sorted entries of one
(the empty path is the root), `console_files_create_directory` makes one with
its parents, and `console_files_remove` and `console_files_rename` delete and
move files or empty directories. Writing a file creates the directories on its
path; read-only assets cannot be removed, renamed, or replaced. `runtime.h` provides
`console_malloc`/`console_realloc`/`console_free`; reallocation preserves existing
bytes and alignment. `stream.h` adds stream cursors and EOF state over
the positional `file` resource, with `r`/`rb` and `w`/`wb` modes.

Freestanding C guests link the [SDK libc](libc/README.md): the hosted C headers
implemented over the reactor's allocator, the stream layer, the log, and the
clock, with musl's math routines. The C reactor in `runtime.rs` uses allocation headers so generated `free()`
helpers and application frees can share canonical buffers. Rust components use
`rust_runtime.rs`, whose raw allocations are compatible with generated
`Vec`/`String` ownership and post-return cleanup. These runtimes serve separate
component memories; their allocation representations are not interchangeable.
`platform.rs` contains the SDK policy and implements generated traits instead of
manually lowering canonical records, strings, or lists. Its `File` type wraps a
HAL handle and closes it when dropped, so a game that drops its `file` resource
closes the file through the generated destructor; a `sheet` keeps its pixels
in a shared buffer that the overlay commands hold until the frame ends.
`font.rs` holds the font. The platform's own `end-frame` export reaches the
linked module because wlink surfaces the bare function exports of a component
that no other component imports.

Native returned buffers use the import's exported allocator and memory accessor.
The host reacquires the memory base after allocations that can grow it. Empty
Rust canonical buffers use aligned non-null dangling pointers. The linked module
imports only the HAL; neither the guest nor platform imports WASI.

## The browser host

[`web/`](web/) is a third implementation of the same HAL, in TypeScript with no
registry dependencies, so `deno bundle --platform browser` produces the page's
script without reaching the network. Its core -- the frame clock, the input
queue and script format, the virtual root, the audio queue, the frame hash and
the trace and summary lines -- is shared by `headless.ts`, a runner with the
native runner's options and output, and `browser.ts`, the page. A test keeps
the layers apart: the core names neither `Deno` nor the DOM, so every decision
that makes a run reproducible is unit-tested, and only the fetching, the
animation frame, the renderers, the audio worklet and IndexedDB are specific to
a browser. `demo:test-doom-web-parity` runs one linked module through the
native runner and the browser host and requires every traced frame and the
summary to be identical.

`terminal.ts` is the same core in a terminal, for the linked modules the
native runner cannot translate: wasm2c has no garbage collector, so a game
gameplayc compiles (whose state is on the GC heap) plays in a terminal
through `console_terminal`, or `sdk/web:terminal --module PATH` with the
native runner's `--seed`, `--save-dir` and `--no-save`, `--no-audio`, and
guest arguments after `--`. It draws half-block cells in 24-bit colour, only
those that changed, dropping frames while the terminal is still writing;
decodes keys, typed text and SGR mouse reports (`tty.ts`, whose decisions are
unit-tested), holding a key down for a moment after each press since a
terminal reports no releases; pipes sound to the first of `pw-cat`, `aplay`,
`play` or `ffplay` that starts; and keeps saves under
`$XDG_DATA_HOME/console/<name>`. `--frames N` runs that many frames without
a keyboard or waiting, for a build's test.

TypeScript is formatted with `deno fmt`, which `jj fix` does not run:

```sh
deno fmt --config tilde/aseipp/wlink/demo/sdk/web/deno.jsonc \
  tilde/aseipp/wlink/demo/sdk/web/*.ts tilde/aseipp/wlink/demo/sdk/web/test/*.ts
```

`sdk/web:fmt` fails the build when that has not been done, `sdk/web:tests`
holds the unit tests and the integration runs against the real linked packages,
and `headless[check]` and `serve[check]` type-check the two Deno entry points,
which `deno run` never does on its own.

Run the application, SDK contract, browser host, native stream/terminal,
binding, and PTY tests:

```sh
buck/bin/buck2 test 'tilde//aseipp/wlink/demo/...'
```
