<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Console SDK

The SDK builds C and Rust games against `console:sdk`, implements that interface
over `console:hal`, and runs the linked core Wasm through wasm2c. Portable guest
code lives alongside the WIT interfaces; `host/` contains the native terminal
runner (for Linux and macOS) and `web/` is a browser host in TypeScript,
which binds to the same raw HAL through `WebAssembly.instantiate` and needs no
component tooling.

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

It declares `:my-game-web` (the directory), `:my-game-web-serve` (a static
server to open it with), `:my-game-web-headless` (the same package replayed
with the native runner's options and output) and a test that checks the built
package against its inputs.

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

## Generated interfaces

[`wit/sdk.wit`](wit/sdk.wit) defines the game API; [`wit/hal.wit`](wit/hal.wit)
defines the platform's host requirements. Edit these sources rather than generated
declarations. Buck runs the pinned upstream `wit-bindgen` download on demand:

| Target under `tilde//aseipp/wlink/demo/sdk/bindings` | Output/use |
| --- | --- |
| `:game-c[h]`, `:game-c[c]` | Guest C header and import/export wrappers |
| `:platform-c[h]` | HAL C types used by the native host |
| `:game-rust` | Rust game imports and `Guest` trait |
| `:platform-rust` | Rust HAL imports and SDK implementation traits |

`console_link` also generates `linked.h` with wasm2c and `hal-host.h` from its
annotated declarations. The latter aliases the actual import, memory, and
allocator symbols; host code does not maintain a separate wasm2c name mangler.
The native boundary still checks the generated HAL record layout when copying
records into Wasm memory. Generated output stays in Buck's output tree.

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
