<!--
SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# quad's design: an editor server and its clients

quad is an editor *server*. Every user interface, whether a terminal in the
same process, a terminal elsewhere, or a graphical client, is a *client* of
it, connected over a *transport*. This is the shape of Emacs's server and of
Neovim's UI protocol. Many clients can be attached at once, to the same
buffers.

```
             core (one per editor)                         clients
 ┌──────────────────────────────────────────────┐
 │ buffers, undo, files, major modes            │   in-process   ┌────────────┐
 │ commands, keymaps, hooks, variables, themes  │◀──────────────▶│ terminal   │
 │ the clipboard history                        │    messages    │ or window  │ quad --gui
 │                                              │                └────────────┘
 │                                              │                ┌────────────┐
 │ per client: views (one per buffer visited),  │◀── frames ────▶│ terminal   │ quad --connect
 │   prompt, layer, jump labels, message, size, │  unix socket   └────────────┘
 │   capabilities                               │                ┌────────────┐
 │ per view: selections, input mode, selection  │◀── frames ────▶│ window     │ quad --gui --connect
 │   mode, extension, scroll, history           │  any stream    └────────────┘
 └──────────────────────────────────────────────┘
```

## State: what is shared and what is a client's

| State | Where | Library |
| --- | --- | --- |
| text, undo history, file, major mode, buffer-locals | the buffer, shared | `core/buffer.sls` |
| commands, keymaps, hooks, variables, themes, kill ring | global, shared | `core/editor.sls` |
| selections, normal/insert mode, selection mode, extend, scroll, selection history | the *view*: one per client per buffer | `core/buffer.sls` |
| which buffer is shown, prompt/picker, layer, jump labels, message, screen size, capabilities, who is at it (name, color) | the *client* | `core/editor.sls` |

Commands run on behalf of one client, the *current client*, the one whose
event is being handled. `current-view`, `current-buffer`, `message`, prompts,
layers and the selection helpers (`sels-of`, `set-sels!`, ...) all refer to
it. `with-client` runs code as another client. Hooks run as the client that
caused them. Code with no client of its own (`--eval`, `--batch`, the init
file) runs as the *background* client, which has no connection.

An edit made through one view remaps the selections of every view of that
buffer (`map-position`), so other clients' cursors follow the text. Undo
restores the selections of the view that undoes. Each client sees the
others' cursors (face `ui.cursor.other`), and its status line counts them.

Leaving (`quit`, `space j v`) detaches the client, and closing a window
or terminal does too. The editor stops when its last client leaves, unless
it is a daemon. `kill-server` stops it for everyone.

Starting quad where an editor already listens at the default socket makes
a client of that editor, as emacsclient does (`--new` starts another). A
client in an editor's process can show another editor instead
(`core/relay.sls`, the `connect` command): its input goes there, that
editor's frames are painted in its place, and this editor's are not; when
the other says goodbye, or goes away, it is drawn afresh here. Its
terminal or window is the same either way: only where its messages go
changes.

## Drawing: the server sends cells

The server draws each client's frame into a grid of cells the size of that
client's screen (`core/display.sls`). It compares the grid with the client's
previous one and sends only the changes. Each cell is one terminal-style
column: a grapheme (or `""` for the right half of a wide character) and a
highlight id. Clients draw cells however suits them: the terminal client
with escape sequences (`core/term.sls`), a GUI with its own text renderer.
Mouse and layout coordinates are cells, both ways.

Cells keep clients simple and identical in behaviour. Things a GUI would
rather draw natively, such as pickers, dialogs, legends, popups, the prompt and smooth
scrolling, can become optional messages later, offered by capability as
Neovim's `ext_*` options are. The grid stays the baseline every client
supports.

## Transports

A transport is anything that delivers a byte stream on a file descriptor.
The server's loop (`core/server.sls`) polls descriptors through the kernel
(`quad_poll`), and `serve-stream!` serves a client on any of them:

- **in-process**: the terminal client in the editor's own process exchanges
  message lists directly, with no encoding (`tui-attach!`);
- **Unix sockets**: `--listen[=PATH]` and `--daemon` accept clients on a
  socket; `--connect[=PATH]` is a terminal client over one; `--connect
  --eval EXPR` evaluates in a running editor;
- **iroh**: `--mesh` (or the command `mesh-listen`) makes the editor an
  `iroh-mesh` host. The kernel's Rust half (`kernel/mesh.rs`) runs its
  endpoint on threads of its own, as an `Object` Scheme holds, and bridges
  each QUIC stream a client opens to one end of a `socketpair`, handing the
  other end to Scheme (through a `Mailbox`, polled with `watch-fd!`) for
  `serve-stream!`. A client (`--connect=CODE` or `=TICKET`) does the same
  the other way round. Clients prove they know the editor's join key, the
  ticket's or the one its six-word join code derives, before any stream;
  the editor announces itself on the mainline DHT under its code, so the
  code alone finds it. Nothing else in Scheme changes.

## Voice

People attached over iroh can talk (`ext/voice.sls`, `space j a`; `space
j m` mutes). Speech goes beside the protocol, not in it: a frame (20 ms
of Opus, `third-party//by-name/op/opus`) per QUIC datagram, on the
connection the client already has, since a reliable stream would hold
every later frame up behind a lost one. The editor is the hub: it sends
each client's frames on, unchanged but for the speaker number it gives
that client, to everyone else in voice, and plays them itself if its own
person is in voice. Each process that plays puts each voice back in order
in a jitter buffer of two to six frames, makes up a lost frame from the
next one's redundancy (in-band FEC) or conceals it, and sums the voices
(`kernel/voice/`). A datagram is version 1, the speaker (0 the editor's
own person), a 16-bit frame number and the Opus packet; in silence
nothing is sent (DTX).

The protocol only says who is in voice. `["voice", mode]` tells a client
over iroh to put its connection in voice (`"on"`, `"muted"`) or out
(`"off"`), and to open the microphone and speakers of the process its
person is at; what fails comes back as `["voice", "failed", why]`.
Clients on the editor's own machine get no message: the editor's process
makes their sound itself. The microphone is open only while someone at
the process is in voice and not muted, and a window that switches to
another editor (`core/relay.sls`) leaves voice in this one first, as its
speech would otherwise go to both. Sound goes through the desktop's
sound server with PulseAudio's simple API (`libpulse-simple.so.0`, which
PipeWire serves), loaded when voice starts, as Vulkan is when a window
opens; each stream shows in the desktop's mixer as quad's. On macOS it
goes through Core Audio's audio queues instead (`kernel/voice/coreaudio.rs`),
to the default input and output, which convert to and from the devices'
own rates; the first time, macOS asks whether the terminal quad was
started from may use the microphone, which records silence until it may.
`QUAD_VOICE_INPUT` and `QUAD_VOICE_OUTPUT` name files of raw samples to
use instead, for tests. There is no echo cancellation yet: use headphones,
or mute.

## The protocol

Messages are lists whose first element is a string naming them. Over a
stream, each is one *frame*: a 4-byte big-endian length, then the message
as a MessagePack array. quad uses the subset of nil, booleans, integers,
floats, strings, binary and arrays; maps are accepted. Highlight colors are
`0xRRGGBB` integers, or false for the default. The protocol version is 2.
`core/protocol.sls` implements it; `tests/protocol.ss` checks known
encodings.

### Client to server

| Message | Meaning |
| --- | --- |
| `["hello", version, name, rows, cols, capabilities]` | first, once: who it is, its size, and what it can do (below) |
| `["user", name]` | who is at the client, for the others to see (name tags, the people list) |
| `["key", name, mods, text, kind]` | a key: `name` as keymaps spell it (`"a"`, `"A"`, `"enter"`, `"left"`, `"space"`); `mods` bits shift 1, alt 2, ctrl 4, super 8 (shift folded into printable names); `text` typed, or false; `kind` `"press"`, `"repeat"` or `"release"` |
| `["paste", text]` | pasted text, as one event |
| `["mouse", kind, button, col, row, mods]` | `kind` `"press"`, `"release"`, `"drag"`, `"scroll-up"`, `"scroll-down"`; cells, from 0 |
| `["focus", in]` | the window gained or lost focus |
| `["resize", rows, cols]` | the screen's new size; the server redraws it whole |
| `["clipboard", target, text]` | the answer to `clipboard-get` |
| `["redraw"]` | send the whole screen again |
| `["open", path, line]` | visit a file (absolute path), at a line or false |
| `["eval", id, expression]` | evaluate Scheme as this client; answered by `result` |
| `["voice", "failed", why]` | the client could not do what `voice` said (see Voice) |
| `["detach"]` | leave |

### Server to client

| Message | Meaning |
| --- | --- |
| `["grid", rows, cols]` | the screen is this size, blank: a whole frame follows |
| `["hl", id, fg, bg, flags, underline_color, link]` | highlight `id` has these colors; `flags` bits bold 1, italic 2, underline 4, undercurl 8, dim 16, reverse 32, double underline 64, dotted 128, dashed 256, strikethrough 512, overline 1024; the underline's color, or false for the text's; the URL its text links to, or false |
| `["line", row, col, cells]` | cells from `(row, col)` rightwards; each `[text]`, `[text, hl]` or `[text, hl, repeat]`, with `hl` carried over from the previous cell when absent, as Neovim's `grid_line` |
| `["scroll", top, bottom, n]` | rows `top` to `bottom` (exclusive) move up `n` rows (down, for negative `n`); `line`s fill those scrolled in (`scroll` capability) |
| `["image", key, width, height, png]` | a PNG, kept under `key` (a hash of it), sent once before it is first placed (`images` capability) |
| `["images", [[key, row, col, rows, cols, shown], ...]]` | the images over the cells now: each fits `rows` by `cols` cells from `(row, col)`, of which its first `shown` rows show (`images` capability) |
| `["cursor", row, col, shape]` or `["cursor", false]` | where to show the text cursor (`"block"`, `"bar"`, `"underline"`), or hide it; `"hidden"` is where it is but drawn by no one, in normal mode, where the selection's colors show it, for screen readers (`hidden-cursor` capability; other clients get `false`) |
| `["flush"]` | the frame is complete: show it |
| `["clipboard-set", target, text]` | put text on the system clipboard (`"c"`) or primary selection (`"p"`) |
| `["clipboard-get", target]` | ask for the system clipboard |
| `["font", family, points, features, fallbacks]` | draw text in this font family at this size, with these OpenType features (HarfBuzz's spellings, separated by spaces or commas) and these fallback families first for what it lacks (`font` capability) |
| `["title", text]`, `["cwd", path]`, `["pointer", shape]`, `["bell"]` | window title, working directory, mouse pointer (a CSS cursor name), bell |
| `["suspend"]` | stop the client's process (a terminal's `^Z`), then redraw |
| `["open-url", url]` | open the URL on the client's machine (`open-url` capability) |
| `["voice", mode]` | put this client's iroh connection in voice, with its person's microphone and speakers (`"on"`, `"muted"`), or out (`"off"`) (`voice` capability) |
| `["result", id, ok, text]` | the answer to `eval`: the value written, or the error |
| `["bye", reason]` | the server is done with this client |

### Capabilities

| Capability | Meaning |
| --- | --- |
| `release-events` | the client reports key releases: Ki's momentary layers work as held layers (hold `r`, press `l`) rather than as prefixes |
| `clipboard` | it has a system clipboard: `clipboard-set` and `clipboard-get` with target `"c"` |
| `primary-selection` | it has a primary selection: `clipboard-set` with target `"p"` |
| `title`, `pointer-shape` | it shows a title and mouse pointer shapes |
| `font` | it chooses its own font (`font`): a window |
| `scroll` | it moves rows itself (`scroll`), so that scrolling sends only the rows scrolled in |
| `open-url` | it can open URLs for its user (it runs in their desktop session) |
| `images` | it draws images (`image`, `images`): a window, or a terminal that speaks kitty's graphics protocol |
| `voice` | its process can make its person's sound in voice (`voice`) |

## A graphical client

quad edits in a window where there is a display (Wayland or X11, or
macOS's window server) and one can open, and in its terminal otherwise
(`--gui` and `--tui` insist on one or the other; why no window opened goes
in `*Messages*`). A window goes on without the terminal it was started
from, which gets its prompt back once the window is open: quad starts a
child, a new quad with the same arguments (see "Threads" below for why
not a fork), which (in a session of its own, its standard streams on
`/dev/null`) opens the window and tells the parent over a pipe whether it
did, and a parent whose child had no window goes on in the terminal
itself. The child starts making what its window draws with before Scheme
boots, as that takes longer.
`--wait` keeps the terminal until the window closes, as `$EDITOR` needs.
The window
attaches in the editor's process (`core/gui.sls`), as the terminal does,
or, as a client (`--connect`, or of a running daemon), opens onto an
editor elsewhere (a socket, or iroh), as a terminal client does: either way
it keeps a grid model and paints it at each `flush`, so it shows what a terminal would, cell for cell, in the same
theme. The window keeps its screen a row at a time (`kernel/screen.rs`):
a flush sends it only the rows that changed, and scrolls move the rest,
so a frame costs about what changed; where the driver can
(`VK_KHR_incremental_present`), the compositor is told which rows those
were, and redraws only them. The window is the Rust half's (`kernel/gui/`): winit's, on
Wayland or X11, drawn with Vulkan 1.3 through ash (on macOS, AppKit's,
drawn with Metal 4: see below). Vulkan is called in
one module alone (`kernel/render/vulkan.rs`): its types own Vulkan's
objects, each holding what it was made from (instance, device, surface,
window) so none outlives it, and destroying itself when dropped; mapped
memory is written only by a frame whose commands are done, and read only
when the device is idle. Each `unsafe` call there says why it holds, and
the rest of the renderer is safe code. Every window of a
process runs on one thread, with one event loop, and draws with one Vulkan
device; `new-window` (`space j w`) opens another onto the same editor, from
a window or a terminal, each a client of its own (with its own size, and
zoom). Its three Slang pipelines (`kernel/gui.slang`) read a frame's data
by buffer device address, with no descriptor sets: rectangles in cells
(the cells' backgrounds, the cursor, underlines), images (scaled on the
CPU, `kernel/image.rs`, to be read a pixel for each drawn; color glyphs
too), and glyphs.

Text is drawn from the fonts' outlines on the GPU, at any size, with no
rasterized atlas: Eric Lengyel's Slug algorithm, whose reference shader
`kernel/gui.slang` ports. `kernel/font/` finds fonts with fontique
(fontconfig, or CoreText on macOS; `gui-font-family`, by default the
built-in JetBrains Mono, else the system's monospace font, at
`gui-font-size` points, with `gui-font-features`), with fallbacks for what
it lacks (`gui-font-fallbacks`, then the system's for each script),
and makes up the styles a family lacks as fontique suggests (a variable
font's weight axis, else outlines emboldened or slanted, as FreeType's
synthetic styles are); takes emoji (those asked for with U+FE0F, and those
two cells wide) from a color font, painted on the CPU
(`kernel/color.rs`: `COLR` versions 0 and 1, with their gradients and
compositing, or `CBDT`/`sbix` bitmaps) into pictures of their cells;
shapes runs of cells in one style with HarfRust, so ligatures and marks
work, and places each glyph at the cell its cluster starts in; and draws
box drawing and blocks itself, to fill their cells exactly, as terminals
do. `kernel/slug.rs` turns outlines (skrifa) into Slug's curve and band
data. The size is chosen so that capitals are a whole number of pixels
tall, as Lengyel suggests for unhinted text. Text blends as ghostty's
does by default on Linux ("linear-corrected"): in linear light, with its
coverage corrected so that glyphs keep the weight they have when blended
gamma-encoded, as most terminals blend. The grid sits 2 points in from
the window's edges, ghostty's padding, and text is 12 points, its size on
Linux (13 on macOS, below).

Nothing links against Vulkan or the window system: `libvulkan.so.1`,
`libwayland-client` and `libX11` are loaded when a window opens. They
are the host's, and so is the GPU driver they load, which cannot load
into a process on the toolchain's C library: on Linux, `:quad` runs on
the host's dynamic linker and libraries (`host` on `chez.standalone`),
which `--gui` needs. `QUAD_VULKAN_VALIDATION=1` turns on the Khronos
validation layer, where it is installed; `QUAD_GUI_X11=1` asks for X11;
`QUAD_GUI_DEVICE=NAME` picks the Vulkan device whose name has NAME in it;
`QUAD_GUI_SNAPSHOT=FILE` writes each frame the window presents to FILE, as
a PPM image; `QUAD_TIMING=1` writes how long each step of starting up took
to standard error.

A window opens in about 150 ms (NVIDIA's driver, on Wayland), most of it
Vulkan's: loading the drivers (about 60 ms) and making a device (about 70).
So the device is made ahead, on another thread, as soon as the editor
starts where a window may open (`gui-prepare`), while the editor, the
event loop and the window are made; the system's fonts are listed
(fontconfig, 10 to 40 ms) only once a family or a character needs them.
Pipelines take under a millisecond, drivers keeping their own shader
caches, so quad keeps no pipeline cache.

Screen readers read a window as they read a terminal: AccessKit
(`kernel/access.rs`) gives the desktop's accessibility bus (AT-SPI) a
tree of the window's terminal, a line of text for each row of cells, laid
out where the row is, with the text cursor as its selection (in normal mode, the selection's
head, which the editor sends as a hidden cursor); each frame
updates the rows it changed. Nothing is built until something on the bus
asks for it.

A window costs nothing while nothing changes: its thread sleeps in the
event loop, and draws only when the editor sends a frame, at the
compositor's next frame callback, so a burst of frames (key repeat,
scrolling) draws at most once a refresh, and a window no one can see draws
nothing. Frames are presented FIFO, never drawn to be thrown away. Laying
out a frame reuses what the last ones laid out: rows by their contents
(wherever they are now), runs of text by their shaping, glyphs by their
curves.

The same renderer draws into images with no window (`gui-headless`,
`draw-frame-image`): `tests/gui-render.ss` draws an editor's frames so and
checks them against its cells -- backgrounds exactly, ink where there is
text, box drawing reaching its cells' edges. `:test-gui-render` runs it on
Mesa's lavapipe, a software renderer, where it is installed, else on any
device (Metal's, on macOS), and skips where nothing can draw.
`tests/golden.ss` (`:test-golden`) draws scenes (code, a picker, every
text style) with the built-in font alone on lavapipe, or on macOS with
Metal, and compares them with the images in `tests/golden`, within a
tolerance for antialiasing; how to draw those again, after a change meant
to change them, is at the top of it. The Rust half's tests check
properties over generated cases too (hegel): rows moved and changed as a
plain list of them would be, coverage adding up to area, compositing
making colors, any bytes from Scheme read or refused.

A client in another process, on Vulkan or any other API, needs to:

1. connect (a Unix socket, or an iroh stream) and send `hello` with
   its size in cells and its capabilities (`release-events` comes free with
   window-system key events);
2. keep a grid model (`core/grid.sls` is the reference): apply `grid`,
   `line`, `hl` and `cursor`, and draw at `flush`;
3. turn its input into `key`, `mouse`, `paste` and `focus` messages, and
   window resizes into `resize` (in cells, from its font metrics);
4. answer `clipboard-get`, and carry out `clipboard-set` and `title`.

Cell widths follow Unicode East Asian Width (`char-width` in
`core/util.sls`), with emoji shown as pictures two columns wide, and a
cell holds a grapheme cluster (`grapheme-end`): a character with its
marks, an emoji with its skin tone or the emoji joined to it, a flag. A
cluster takes its first character's columns, or two for an emoji asked
for as a picture (U+FE0F) and for a flag, as terminals that cluster
graphemes (mode 2027, which the terminal client asks for) count them; the
editor moves over and deletes clusters whole. The server marks the right
half of each wide character with an empty cell, so a client never has to
measure text itself.

### Threads

AppKit runs a process's windows on its main thread alone, and quad does
so everywhere, so that both platforms run alike: the kernel
(`kernel/kernel.c`) runs Scheme on a thread of its own, with a main
thread's stack and the signals the terminal sends (the main thread blocks
them), and gives the main thread to the Rust half (`kernel/main_thread.rs`),
which runs the windows' event loop there once the first window opens, and
ends the process from there once Scheme is done. Signals reach Scheme's
waits through a pipe their handlers write to, whichever thread they land
on; SIGTERM and SIGHUP stop the editor as quitting does, saying goodbye to
its clients (a second one, if it is too busy to stop, ends it at once).
Detaching cannot fork: the child would have Scheme's thread alone, and no
main thread to run windows on (and macOS's frameworks refuse to run in
the child of a process that had threads at all). The child is a new quad,
with the same arguments, told the pipe to its parent in
`QUAD_DETACHED_FD`, which takes the forked child's part as it gets to
where the parent would have forked.

### On macOS

An app that Finder, the Dock or `open` started (`quad.app`) has launchd
for its parent: it has no terminal to detach from, so its window stays in
its own process, and, as macOS starts every app in `/`, it starts in the
home directory instead.

Windows are drawn with Metal 4 (macOS 26, on Apple silicon). Metal is
called in one module alone (`kernel/render/metal.rs`), as Vulkan is, on
the same terms: its types own Metal's objects, each holding the device it
was made on, and a layer its window; and since Metal 4, as Vulkan, keeps
nothing a command uses alive or resident and orders one pass after another
only when asked, every buffer and image is in the device's residency set
while it lives, a window's drawables are in its layer's, and a frame's
copy waits for its drawing with a barrier. The same Slang source compiles
to Metal's shading language (`slangc -target metal`), all six entry points
in one library that Metal compiles when the device is made (ahead, as
Vulkan's is), in IEEE arithmetic rather than Metal's fast math, as Slug's
root finding meets infinities; Metal's clip space runs bottom to top, which
the shader turns over (`clipY`). The pipelines find their `Params` in
buffer 0 of an argument table, each draw binding its own. A window draws
into a `CAMetalLayer` its view hosts, in BGRA8 sRGB, and the layer says
its colors are sRGB's, which macOS matches to the display's, as it does a
terminal's. Metal presents whole drawables, so the compositor is not told
which rows changed. Headless frames draw on the Mac's GPU, and come out
within a level or two of lavapipe's.

A window opens in about 80 ms (an M4 Pro), and shows its first frame at
90: the device and its shaders are ready in under 20 ms, compiled from
Metal's shader cache, and the fonts (CoreText) take most of the rest. The
clipboard is the general pasteboard, and there is no primary selection.
Option types the characters the keyboard's layout gives it, as macOS
terminals take it, and is alt with keys it changes nothing of. A point is a
logical pixel on macOS, where Linux takes 96 to the inch, so fonts lay out
at three quarters of the scale they would there, and text is 13 points,
ghostty's size on macOS. winit's menu would end the process at once, and so
would AppKit's answer to a quit asked by Apple event (the Dock's Quit,
logging out): quad's own menu (`kernel/gui/macos.rs`) and answer close
every window instead, as their close buttons do. AccessKit's macOS adapter
gives VoiceOver the same tree AT-SPI gets. A window can open where the
process shares a login session with the window server
(`CGSessionCopyCurrentDictionary`), which one started over ssh does not;
`QUAD_NO_DISPLAY=1` says there is no display, on macOS or Linux.
