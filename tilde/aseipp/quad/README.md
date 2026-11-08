<!--
SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# quad

An editor platform in the spirit of Emacs, written in [Chez Scheme], with
[Ki]'s selection-first modal bindings and a modern terminal front end.

A small kernel in C (`kernel/`) boots Chez Scheme and provides the
primitives Scheme can't express itself. Everything else is Scheme: the text
buffer, the selection modes, the keymaps, the renderer, the commands
(`core/`), and the language modes and other extensions built in by default
(`ext/`). All of it is visible to your init file, which can redefine any of
it while the editor runs.

```sh
buck2 build depot-tilde//aseipp/quad:quad    # the standalone executable
```

## Clients and servers

quad is an editor server, and every user interface is a client of it:
several can be attached at once, to the same buffers, each with its own
selections, modes and prompt, each seeing the others' cursors. The server
draws each client's screen as cells and sends what changed; clients send
key, mouse and paste events. [docs/design.md](docs/design.md) has the
architecture and the protocol, which a graphical client would speak too.

```sh
quad --daemon FILE         # an editor, for clients
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
with mimalloc, which overrides malloc for C and Chez Scheme alike. The
full Chez compiler is in it, so extensions are compiled, not interpreted.

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

## Extensions

`ext/*.sls` are the libraries `(quad ext NAME)`, each a `chez.library`
target of its own; `EXTENSIONS` in `BUILD` picks the ones the editor is built
with, and the generated program invokes each as the editor boots, which is
when it registers its modes, commands and keys. The built-in ones are `lisp` (Scheme and other Lisps: s-expressions
for the NODE mode, Lisp indentation), `c` (C-like languages), `shell`
(`#`-commented languages) and `markdown`.

## Layout

| File | |
| --- | --- |
| `kernel/kernel.c` | boots Chez from the appended boot files; termios, poll, SIGWINCH |
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
| `core/face.sls` | faces and themes (the default is Helix's purple) |
| `core/main.sls` | the command line, headless clients for testing |
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
