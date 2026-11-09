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
quad --daemon --mesh       # ... joinable over iroh, from anywhere
quad --connect=rock-stir-duct-feed-slick-showy   # by the code it printed
```

The socket is `$QUAD_SOCKET`, else `quad.sock` in `$XDG_RUNTIME_DIR/quad`;
`--listen=PATH` and `--connect=PATH` name another. Quitting (`space j v`)
detaches a client; the editor stops with its last client, unless it is a
daemon (`space j k` stops it for everyone).

### Working together

Everyone attached to an editor works in the same buffers, as one editor, so
there is nothing to merge or keep in step: an edit is in everyone's buffer
at once. Each person has a name (`$QUAD_USER`, else `user@host`) and a
color, and sees the others' cursors and selections in their colors, with
their names at the end of the lines their cursors are on; the status line
says who else is in the buffer. `space j l` lists the people here and where
they are, and following one keeps your view on theirs (their buffer, their
cursor, their scroll) until you press a key. `space j t` says something to
everyone, and `space j h` shows the chat, and who came and went. Over iroh
(below), that is anyone, anywhere, with the code.

With `--mesh` (or the command `mesh-listen`, in a running editor) an
editor also accepts clients over [iroh](https://iroh.computer), through
NATs and from anywhere, using the repository's `iroh-mesh`. It prints a
six-word join code and a ticket, and announces itself under the code on
the mainline DHT, so `quad --connect=CODE` finds it with no address at
all. The code and the ticket are credentials: a client proves it knows
the key they carry before it can attach. So they are made up afresh, with
a fresh identity, each time the editor starts listening, and written
nowhere: once it stops they mean nothing. By ticket, a client connects in
tens of milliseconds; by code, in a second or two, most of it Argon2
making each guess at a code expensive, and the DHT lookup. `mesh-info`
shows the code and copies a ticket.

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
the text are; the same movements work in every mode. New to them? `quad
--tutor` (or `space k h`) teaches them in about half an hour, vimtutor
style: lessons, each with lines to practise on.

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
| `n` | local menu: `n d` search, `n f` search the selection, `n n` all occurrences; with a language server, `n x` definition, `n v` references, `n a` diagnostics (below) |
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
| `space` | menu: `space space` command palette, `space e` eval, `space k d` files, `space k f` buffers, `space ;` explorer, `space /` every key, `space j v` quit, `space a` the agent (below) |

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

## An agent that extends the editor

`space a a` opens a box in the middle of the screen, "Submit Feedback to
AI", where you tell an agent what to change or add to quad itself: "bind
ctrl+d to duplicate the line", "a darker theme", "a mode for TOML". It
edits your init file, applies the change to the running editor and checks
it. A popup at the top right keeps a summary of what it is doing, a few
lines that a small, quick model (`codex-summary-model`, GPT-6-Luna, at low
effort) rewrites every few seconds as it works, and once more when it is
done; `space a t` has the whole log. The summarizer reads the log as the
project reviewer reads code (see Projects): as single samples of a thread,
which can run nothing. The agent is OpenAI Codex, through its app server
(`codex app-server`, which must be on `PATH` and logged in).

quad gives the agent tools of its own (`quad_eval`, `quad_describe`,
`quad_apropos`, `quad_keymap`, `quad_reload_config`, `quad_context`), so it
finds the API rather than guessing, and each question carries what you are
looking at. It works in the init file's directory, under Codex's
`workspace-write` sandbox; anything more it asks first, in a picker. It
can ask you questions as it works, and an MCP server it uses can ask too:
for a form's values (a dialog or picker for each field), to open a link, or
for more permissions. Each waits its turn; `space a y` takes up one you
dismissed. While it works, `space a a` again steers
it and `space a i` interrupts it; `space a t` is the whole conversation,
`space a n` starts another, `esc` hides the popup and `space a p` brings it
back. The variables `codex-command`, `codex-model`, `codex-sandbox`,
`codex-approval-policy`, `codex-directory`, `codex-questions`,
`codex-summary-model` (`#f` shows the log instead of a summary),
`codex-summary-effort`, `codex-summary-interval` and `codex-log` change how it
runs, and `define-codex-tool!` gives it more tools: the agent can write
those too.

## Language servers

The `lsp` extension makes quad a Language Server Protocol client. Opening a
file starts the server for its extension, if its command is on `PATH`:
clangd, rust-analyzer, gopls, pyright or pylsp, typescript-language-server,
zls, bash-language-server, nixd, and Lean's `lake serve`. One runs per
project, rooted at the nearest directory up from the file with a marker
(`.git`, `Cargo.toml`, `compile_commands.json`...). The buffer is kept in
step change by change, and diagnostics underline the text, with their
count in the status line; landing on one shows its message.

| Keys | |
| --- | --- |
| `n x` `n X` `n b` `n c` | definition, declaration, implementation, type definition |
| `n v` `n V` | references, without and with the declaration |
| `n a` `n s` `n w` `n q` `n Q` | diagnostics as a selection mode (all, errors, warnings, hints, information): `l` and `j` go between them |
| `space l s` | hover |
| `space l f` | rename, in every file |
| `space l d` | code actions |
| `space l =` | format the buffer |
| `space k y` `space k Y` | symbols in the buffer, in the workspace |
| `space k e` | every diagnostic, in every file |
| `ctrl+space` | (insert mode) complete: a menu at the cursor, narrowed as you type |

`lsp-restart`, `lsp-stop`, `lsp-info` and `lsp-log` are in the command
palette. Another server is a line in the init file, or a project's:

```scheme
(define-lsp-server! 'ocamllsp '("ocamllsp") '("ml" "mli") 'roots '("dune-project" ".git"))
(define-lsp-server! 'gopls '("gopls") '("go") 'root "/src/repo"
  'config '((directoryFilters . #("-buck-out"))))   ; its settings, as Helix's `config`
(lsp-servers-from-json "servers.json")              ; Claude Code's LSP plugin format
```

A server a project defines is for that project's files, ahead of the
others, and goes when the project reloads. quad tells a server of the files
it saves that match the globs it asks to watch, as rust-analyzer does for
`BUILD` files.

## Projects

A directory with a `.quad/init.ss` is a project: opening a file in it (or
starting quad there) loads that configuration, for the project's files,
after your own. Projects nest; the inner one's settings come last. It runs
with all of quad in scope, and can also say:

```scheme
(project-root)                    ; this project's directory
(project-path "buck/tool")        ; a path in it
(project-set! 'tab-width 4)       ; a variable, for the project's buffers
(project-buffer-hook! proc)       ; (proc buffer) for each of its buffers
(project-add-hook! 'hook proc)    ; add-hook!, undone when it reloads
```

That is code from a repository, so quad asks before running it, as Helix
and VS Code do. You can trust it, read it first, or have an AI review it
first: Codex reads `.quad/` without any tools, as a single model sample
(`thread/sample`) that can run nothing, the code fenced by a random marker
it cannot forge, in a thread started outside the repository and deleted
after. The verdict is advice, shown with the question; the code could be
written to mislead its reader. Trust is kept by a hash of `.quad/`, in
`$XDG_STATE_HOME/quad/trusted`, so any change asks again. `project-trust`,
`project-reload`, `project-forget` and `project-info` are commands; `quad
-q` loads no project. This repository's own `.quad/init.ss` runs the
language servers through Buck, from the same file Claude Code's plugin
uses, and trims whitespace on save as `.helix/` has it.

`trim-trailing-whitespace` and `trim-final-newlines` are variables of
their own, for any buffer.

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

Subprocesses are a component too, `spawn-process`, with pipes to and from
the program; Scheme polls and reads its output's descriptor like any other.
`core/jsonrpc.sls` speaks JSON-RPC to such programs: a message per line, as
Codex's app server and MCP servers do, or after a `Content-Length` header,
as language servers do.

## Extensions

`ext/*.sls` are the libraries `(quad ext NAME)`, each a `chez.library`
target of its own; `EXTENSIONS` in `BUILD` picks the ones the editor is built
with, and the generated program invokes each as the editor boots, which is
when it registers its modes, commands and keys. The built-in ones are `lisp` (Scheme and other Lisps: s-expressions
for the NODE mode, Lisp indentation), `c` (C-like languages), `shell`
(`#`-commented languages), `markdown`, `blake3`, `codex`, the agent, `lsp`,
language servers, `people`, working together, and
`tutor`, whose lessons are `ext/tutor.md`, compiled in (`EXTENSION_DATA`
in `BUILD` gives an extension files to include as it compiles).

## Layout

| File | |
| --- | --- |
| `kernel/kernel.c` | boots Chez from the appended boot files; termios, poll, SIGWINCH |
| `kernel/lib.rs` | the Rust half: `(quad native)`'s procedures, subprocesses |
| `core/kernel.sls` | the kernel's primitives, bound for Scheme |
| `core/text.sls` | gap buffer with an incremental line index |
| `core/buffer.sls` | buffers, the views of them (selections, modes, scroll), undo, files |
| `core/syntax.sls` | the highlighting lexer and the node tree |
| `core/selection.sls` | selection modes and movements |
| `core/event.sls` | input events, as clients report them |
| `core/editor.sls` | the core and extension API: clients, buffers, commands, keymaps, hooks, variables, prompts, popups |
| `core/commands.sls` | the standard commands and Ki's keymaps |
| `core/display.sls` | drawing each client's frame, sent as changed cells |
| `core/protocol.sls` | the client protocol: MessagePack frames, events as messages |
| `core/server.sls` | the event loop over descriptors, sockets, client messages |
| `core/grid.sls` | a client's model of its screen |
| `core/json.sls`, `core/jsonrpc.sls` | JSON, and JSON-RPC with a subprocess |
| `core/term.sls`, `core/tui.sls` | the terminal client: input decoding, painting, in-process or over a socket |
| `core/face.sls` | faces and themes (the default is Helix's purple) |
| `core/mesh.sls`, `kernel/mesh.rs` | editors and clients over iroh (`iroh-mesh`) |
| `core/project.sls` | projects: `.quad/` configuration, trust, review |
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
