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

## A graphical client

quad edits in a window where there is a display (Wayland or X11) and one
can open, and in its terminal otherwise (`--gui` and `--tui` insist on
one or the other; why no window opened goes in `*Messages*`). A window
goes on without the terminal it was started from, which gets its prompt
back once the window is open: quad forks before anything starts a thread,
the child (in a session of its own, its standard streams on `/dev/null`)
opens the window and tells the parent over a pipe whether it did, and a
parent whose child had no window goes on in the terminal itself.
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
Wayland or X11, drawn with Vulkan 1.3 through ash. Every window of a
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
(fontconfig; `gui-font-family`, by default the built-in JetBrains Mono,
else the system's monospace font, at `gui-font-size` points, with
`gui-font-features`), with fallbacks for what it lacks
(`gui-font-fallbacks`, then fontconfig's for each script),
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
Linux.

Nothing links against Vulkan or the window system: `libvulkan.so.1`,
`libwayland-client` and `libX11` are loaded when a window opens. They
are the host's, and so is the GPU driver they load, which cannot load
into a process on the toolchain's C library: `:quad-host` is quad on the
host's dynamic linker and libraries (`host` on `chez.standalone`), and
`--gui` needs it. `QUAD_VULKAN_VALIDATION=1` turns on the Khronos
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
Mesa's lavapipe, a software renderer, where it is installed, and skips
where nothing can draw. `tests/golden.ss` (`:test-golden`) draws scenes
(code, a picker, every text style) with the built-in font alone on
lavapipe and compares them with the images in `tests/golden`, within a
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
