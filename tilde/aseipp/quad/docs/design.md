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
 │ the clipboard history                        │    messages    └────────────┘
 │                                              │                ┌────────────┐
 │ per client: views (one per buffer visited),  │◀── frames ────▶│ terminal   │ quad --connect
 │   prompt, layer, jump labels, message, size, │  unix socket   └────────────┘
 │   capabilities                               │                ┌────────────┐
 │ per view: selections, input mode, selection  │◀── frames ────▶│ GUI        │ (to come)
 │   mode, extension, scroll, history           │  any stream    └────────────┘
 └──────────────────────────────────────────────┘
```

## State: what is shared and what is a client's

| State | Where | Library |
| --- | --- | --- |
| text, undo history, file, major mode, buffer-locals | the buffer, shared | `core/buffer.sls` |
| commands, keymaps, hooks, variables, themes, kill ring | global, shared | `core/editor.sls` |
| selections, normal/insert mode, selection mode, extend, scroll, selection history | the *view*: one per client per buffer | `core/buffer.sls` |
| which buffer is shown, prompt/picker, layer, jump labels, message, screen size, capabilities | the *client* | `core/editor.sls` |

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

Leaving (`quit`, `space j v`) detaches the client. The editor stops when its
last client leaves, unless it is a daemon. `kill-server` stops it for
everyone.

## Drawing: the server sends cells

The server draws each client's frame into a grid of cells the size of that
client's screen (`core/display.sls`). It compares the grid with the client's
previous one and sends only the changes. Each cell is one terminal-style
column: a grapheme (or `""` for the right half of a wide character) and a
highlight id. Clients draw cells however suits them: the terminal client
with escape sequences (`core/term.sls`), a GUI with its own text renderer.
Mouse and layout coordinates are cells, both ways.

Cells keep clients simple and identical in behaviour. Things a GUI would
rather draw natively, such as pickers, legends, the prompt and smooth
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
- **others, such as Iroh**: the kernel's Rust half (written with the `chez`
  crate) can run an endpoint on threads of its own, as an `Object` Scheme
  holds, and bridge each QUIC stream to one end of a `socketpair`, handing
  the other end to Scheme (through a `Mailbox`, polled with `watch-fd!`)
  for `serve-stream!`. Nothing else in Scheme changes.

## The protocol

Messages are lists whose first element is a string naming them. Over a
stream, each is one *frame*: a 4-byte big-endian length, then the message
as a MessagePack array. quad uses the subset of nil, booleans, integers,
floats, strings, binary and arrays; maps are accepted. Highlight colors are
`0xRRGGBB` integers, or false for the default. The protocol version is 1.
`core/protocol.sls` implements it; `tests/protocol.ss` checks known
encodings.

### Client to server

| Message | Meaning |
| --- | --- |
| `["hello", version, name, rows, cols, capabilities]` | first, once: who it is, its size, and what it can do (below) |
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
| `["hl", id, fg, bg, flags]` | highlight `id` has these colors; `flags` bits bold 1, italic 2, underline 4, undercurl 8, dim 16, reverse 32 |
| `["line", row, col, cells]` | cells from `(row, col)` rightwards; each `[text]`, `[text, hl]` or `[text, hl, repeat]`, with `hl` carried over from the previous cell when absent, as Neovim's `grid_line` |
| `["cursor", row, col, shape]` or `["cursor", false]` | where to show the text cursor (`"block"`, `"bar"`, `"underline"`), or hide it |
| `["flush"]` | the frame is complete: show it |
| `["clipboard-set", target, text]` | put text on the system clipboard (`"c"`) or primary selection (`"p"`) |
| `["clipboard-get", target]` | ask for the system clipboard |
| `["title", text]`, `["cwd", path]`, `["pointer", shape]`, `["bell"]` | window title, working directory, mouse pointer (a CSS cursor name), bell |
| `["suspend"]` | stop the client's process (a terminal's `^Z`), then redraw |
| `["result", id, ok, text]` | the answer to `eval`: the value written, or the error |
| `["bye", reason]` | the server is done with this client |

### Capabilities

| Capability | Meaning |
| --- | --- |
| `release-events` | the client reports key releases: Ki's momentary layers work as held layers (hold `r`, press `l`) rather than as prefixes |
| `clipboard` | it has a system clipboard: `clipboard-set` and `clipboard-get` with target `"c"` |
| `primary-selection` | it has a primary selection: `clipboard-set` with target `"p"` |
| `title`, `pointer-shape` | it shows a title and mouse pointer shapes |

## A graphical client

A Vulkan client, or one on any other API, needs to:

1. connect (a Unix socket now; an Iroh stream later) and send `hello` with
   its size in cells and its capabilities (`release-events` comes free with
   window-system key events);
2. keep a grid model (`core/grid.sls` is the reference): apply `grid`,
   `line`, `hl` and `cursor`, and draw at `flush`;
3. turn its input into `key`, `mouse`, `paste` and `focus` messages, and
   window resizes into `resize` (in cells, from its font metrics);
4. answer `clipboard-get`, and carry out `clipboard-set` and `title`.

Cell widths follow Unicode East Asian Width (`char-width` in
`core/util.sls`). The server marks the right half of each wide character
with an empty cell, so a client never has to measure text itself.
