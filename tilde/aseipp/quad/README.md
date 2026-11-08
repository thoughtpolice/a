<!--
SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# quad

An editor platform in the spirit of Emacs, written in [Chez Scheme], with
[Ki]'s selection-first modal bindings and a modern terminal front end.

A small kernel in C and Rust (`kernel/`) boots Chez Scheme and provides the
primitives Scheme can't express itself. Everything else is Scheme: the text
buffer, the selection modes, the keymaps, the renderer, the commands
(`core/`), and the language modes and other extensions built in by default
(`ext/`). All of it is visible to your init file, which can redefine any of
it while the editor runs.

```sh
buck2 run depot-tilde//aseipp/quad:quad -- FILE...
buck2 build depot-tilde//aseipp/quad:quad       # the standalone executable
```

## Clients and servers

quad is an editor server, and every user interface is a client of it:
several can be attached at once, to the same buffers, each with its own
selections, modes and prompt, each seeing the others' cursors. The server
draws each client's screen as cells and sends what changed; clients send
key, mouse and paste events. [docs/design.md](docs/design.md) has the
architecture and the protocol, which a graphical client would speak too.

```sh
quad FILE                  # an editor with this terminal attached
quad --listen FILE         # ... that other clients can attach to as well
quad --daemon FILE         # an editor with no terminal, for clients
quad --connect             # a terminal client of a running editor
quad --connect --eval '(map client-name (clients))'
```

The socket is `$QUAD_SOCKET`, else `quad.sock` in `$XDG_RUNTIME_DIR/quad`;
`--listen=PATH` and `--connect=PATH` name another. Quitting (`space j v`)
detaches a client; the editor stops with its last client, unless it is a
daemon (`space j k` stops it for everyone).

## Distribution

`quad` is a single executable: the kernel with Chez Scheme's `petite.boot`
and `scheme.boot` and quad's own boot file appended (`embed.sls` in the Chez
toolchain has the layout). It needs only libc at run time, and allocates
with mimalloc, which overrides malloc for C, Chez Scheme and Rust alike. The
full Chez compiler is in it, so extensions are compiled, not interpreted.

`quad --build-exe OUT FILE...` writes a new standalone editor: a copy of
itself with `FILE...` compiled into one more boot file, whose code runs as
the editor boots. That is how a configured editor becomes one binary to hand
out; `defs.bzl`'s `quad_executable` does the same from Buck, and
`:quad-custom` builds `examples/site.ss` into one.

## The terminal

quad asks the terminal what it speaks and uses the best of it: Ghostty,
kitty, WezTerm, foot, iTerm2 and other modern terminals get

- the kitty keyboard protocol, for unambiguous keys and key *release*
  events, which make Ki's momentary layers work as designed;
- synchronized output (mode 2026), so frames never tear;
- 24-bit color (`QUAD_256=1` falls back to 256 colors);
- SGR mouse reporting: click to select, drag to extend, double-click a word,
  triple-click a line, shift-click to extend, alt-click to add a cursor,
  middle-click to paste the primary selection, the wheel to scroll;
- OSC 52 clipboard writes, for copy (and the primary selection, from mouse
  selections), over ssh too, and OSC 52 reads for `space v`;
- bracketed paste, focus events (files changed on disk are reloaded when you
  come back), cursor shapes, window titles, OSC 7 and OSC 22.

Older terminals get the xterm encodings; `QUAD_LEGACY_KEYS=1` forces them.

## Keys

The bindings are Ki's on QWERTY. A *selection mode* says what the units of
the text are; the same movements work in every mode.

| Keys | |
| --- | --- |
| `j` `l` | previous/next unit (`<<` `>>`) |
| `i` `k` | unit above/below (for nodes: parent/first child) |
| `u` `o` | previous/next unit of any kind (symbols, blank lines) |
| `y` `p` | first/last unit |
| `m` | jump: label the visible units, type a label |
| `a` `A` | LINE, LINE* (with the newline) |
| `s` `S` | WORD, WORD* (non-blank runs) |
| `w` `W` | SUBWORD (`fooBar_baz`), CHAR |
| `d` | NODE: s-expressions in Lisps, bracket structure elsewhere |
| `E` | PARAGRAPH |
| `n` | local menu: `n d` search, `n f` search the selection, `n n` all occurrences |
| `f` | extend: following movements grow the selection; `f f` selects all |
| `h` `;` | insert before/after |
| `g` | change (layer: `g k`/`g i` open a line, `g l`/`g j` open a gap) |
| `r` | delete (layer: `r l`, `r j`, `r p`... delete towards a movement) |
| `x` | cut (layer, like `r`) |
| `c` | copy (layer: `c l` duplicate, ...) |
| `v` | replace with the clipboard (layer: `v l` paste after with a gap, `v k` below, `v y`/`v p` clipboard history) |
| `t` | swap with a neighbor (layer: `t l`, `t j`, ...) |
| `b` | add a cursor (layer: `b l`, `b k`, ... ; `b f` all occurrences) |
| `z` `Z` | undo (layer: `z u`/`z o` fine-grained), redo |
| `I` `K` `L` `J` | join, break, indent, dedent |
| `F` | transform: cases, `F k` comment |
| `,` | surround: `, s m` wraps in `()`, `, r m` unwraps, `, d m` selects inside |
| `e` | buffers (layer) |
| `enter` | save |
| `space` | menu: `space space` command palette, `space e` eval, `space k d` files, `space k f` buffers, `space ;` explorer, `space /` every key, `space j v` quit |

Layers are momentary: hold `r` and press `l` to delete rightwards (again
and again while `r` is held); tap `r` alone to delete the selection. Hold a
layer key a moment and its keys appear. Without the kitty protocol, press the
layer key, then the next key; press it twice for its default.

## Extending

The init file is `$QUAD_INIT`, else `$XDG_CONFIG_HOME/quad/init.ss`, else
`~/.config/quad/init.ss`. It runs with all of quad in scope:

```scheme
(define-command 'shout "Upcase the selections"
  (lambda () (edit-sels! (lambda (s)
                           (let ([t (string-upcase (selection-text (current-buffer) s))])
                             (list (sel-range-start s) (sel-range-end s) t
                                   (lambda (p) (make-sel p (+ p (string-length t))))))))))

(define-key normal-keymap "ctrl+u" 'shout "Shout")
(define-key (keymap-lookup-target space-keymap "l") "u" 'shout "Shout")
(set-var! 'line-numbers 'relative)
(set-face! 'keyword '((fg "#ff79c6") bold))
(add-hook! 'after-save-hook (lambda (b) (message "saved ~a" (buffer-name b))))
```

`space e` evaluates an expression; in a Scheme buffer, select a form with
`d` and press `space l e`. `quad --repl` is a Chez REPL with quad loaded.
`examples/init.ss` shows more.

## The kernel

`kernel/kernel.c` boots Chez Scheme from the boot files appended to its
executable (`toolchains//chez:embed`) and registers the primitives Scheme
can't express itself: raw terminal I/O, `poll`, Unix sockets.
`core/kernel.sls` binds them.

The Rust half, `kernel/lib.rs`, is written with the `chez` crate
(`chez-rs/`). Each `#[chez::procedure]` is an ordinary Rust function
that becomes a Scheme procedure in `(quad native)`, which the build generates
from the Rust:

```rust
/// The BLAKE3 hash of a bytevector: a 32-byte bytevector.
#[chez::procedure]
fn blake3(data: Bytes) -> ByteVec { ... }

#[chez::procedure]
fn make_ticker(interval_ms: u64, count: u64) -> Result<Object<Ticker>, String> { ... }

chez::library! { pub fn native() -> "quad native" { blake3, make_ticker, ... } }
```

Arguments and results convert by their Rust types. A wrong argument, an
`Err` or a panic is a Scheme error that names the argument. A Rust value
returned as `Object<T>` is a handle that Scheme passes back as `Ref<T>` or
`RefMut<T>`: its type is checked, borrows are checked, and it is dropped
once Scheme no longer references it. A component with threads of its own
(the network, next) hands Scheme a `Mailbox`, and `watch-fd!` adds its
descriptor to the editor's event loop; the ticker is the smallest example.
`ext/blake3.sls` (`space l h`) and `tests/native.ss` use these. Nothing is
registered by hand, and there are no pointers in sight.

## Extensions

`ext/*.sls` are the libraries `(quad ext NAME)`, each a `chez.library`
target of its own; `EXTENSIONS` in `BUILD` picks the ones the editor is built
with, and the generated program invokes each as the editor boots, which is
when it registers its modes, commands and keys. The built-in ones are `lisp` (Scheme and other Lisps: s-expressions
for the NODE mode, Lisp indentation), `c` (C-like languages), `shell`
(`#`-commented languages), `markdown` and `blake3`.

## Layout

| File | |
| --- | --- |
| `kernel/kernel.c` | boots Chez from the appended boot files; termios, poll, SIGWINCH |
| `kernel/lib.rs` | the Rust half: `(quad native)`'s procedures |
| `core/kernel.sls` | the kernel's primitives, bound for Scheme |
| `core/text.sls` | gap buffer with an incremental line index |
| `core/buffer.sls` | buffers, the views of them (selections, modes, scroll), undo, files |
| `core/syntax.sls` | the highlighting lexer and the node tree |
| `core/selection.sls` | selection modes and movements |
| `core/event.sls` | input events, as clients report them |
| `core/editor.sls` | the core and extension API: clients, buffers, commands, keymaps, hooks, variables, prompts |
| `core/commands.sls` | the standard commands and Ki's keymaps |
| `core/display.sls` | drawing each client's frame, sent as changed cells |
| `core/protocol.sls` | the client protocol: MessagePack frames, events as messages |
| `core/server.sls` | the event loop over descriptors, sockets, client messages |
| `core/grid.sls` | a client's model of its screen |
| `core/term.sls`, `core/tui.sls` | the terminal client: input decoding, painting, in-process or over a socket |
| `core/face.sls` | faces and themes (the default is Helix's purple) |
| `core/main.sls` | the command line, `--build-exe`, headless clients for testing |
| `ext/*.sls` | the built-in extensions |

The Scheme builds with the Chez Scheme toolchain (`buck/toolchains/chez`):
`:core` and each `:ext-*` are `chez.library` targets, compiled against their
dependencies' objects, so changing an extension recompiles that extension
and what is built from it, not the core. `:program`, `:boot` and `:quad`
are the program, its boot file and the standalone executable.

The tests (`tests/*.ss`) run with `quad --batch`, as headless clients that
keep a model of their screen from the server's messages, as any client does;
`tests/clients.ss` has several at once, and `:test-remote` runs a daemon with
clients in other processes.

[Chez Scheme]: https://cisco.github.io/ChezScheme/
[Ki]: https://ki-editor.org
