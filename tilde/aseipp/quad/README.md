<!--
SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# quad

An editor platform in the spirit of Emacs, written in [Chez Scheme], with
[Ki]'s selection-first modal bindings and a modern terminal front end. It
runs on Linux and macOS, in a terminal or in a window of its own, drawn with
Vulkan on Linux and Metal 4 on macOS.

A small kernel in C and Rust (`kernel/`) boots Chez Scheme and provides the
primitives Scheme can't express itself. Everything else is Scheme: the text
buffer, the selection modes, the keymaps, the renderer, the commands
(`core/`), and the language modes and other extensions built in by default
(`core/ext/`). All of it is visible to your init file, which can redefine any of
it while the editor runs.

```sh
buck2 run depot-tilde//aseipp/quad:quad -- FILE...
buck2 build depot-tilde//aseipp/quad:quad            # the standalone executable
buck2 install -m release depot-tilde//aseipp/quad:quad   # into ~/.local
```

## Clients and servers

quad is an editor server, and every user interface is a client of it:
several can be attached at once, to the same buffers, each with its own
selections, modes and prompt, each seeing the others' cursors. The server
draws each client's screen as cells and sends what changed; clients send
key, mouse and paste events. [docs/design.md](docs/design.md) has the
architecture and the protocol, which a graphical client in another process
would speak too.

```sh
quad FILE                  # an editor in a window,
                           # or in this terminal where no window can open
quad --tui FILE            # ... in this terminal, always
quad --gui FILE            # ... in a window, always
quad --listen FILE         # ... that other clients can attach to as well
quad --daemon FILE         # an editor with no terminal, for clients
quad FILE                  # with a daemon running: its client, as emacsclient
quad --new FILE            # ... or an editor of its own anyway
quad --connect             # a client of a running editor, in a window or here
quad --tui --connect       # ... in this terminal, always
quad --connect --eval '(map client-name (clients))'
quad --daemon --mesh       # ... joinable over iroh, from anywhere
quad --connect=rock-stir-duct-feed-slick-showy   # by the code it printed
```

`space j W` opens another window onto the same editor, from a window or a
terminal. A terminal or window can also switch to another editor and back, as
tmux's switch-client does: `space j o` (`connect`) asks for a socket path,
or a join code or ticket (empty: this machine's daemon), and shows that
editor in its place; leaving it (`space j v`) comes back to this one, which
kept running meanwhile.

The socket is `$QUAD_SOCKET`, else `quad.sock` in `$XDG_RUNTIME_DIR/quad`,
or, where that is unset (macOS), in `/tmp/quad-$USER`; `--listen=PATH` and
`--connect=PATH` name another. Quitting (`space j v`) detaches a client;
the editor stops with its last client, unless it is a daemon (`space j k`
stops it for everyone).

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

`space j a` turns voice on: you hear everyone else who has, and they hear
you, and everyone is told you joined; `space j m` mutes your microphone,
and `space j a` again leaves. Nobody hears or is heard until they turn it
on themselves. The status line says how many are in voice, and who is
talking, as they start and stop; the people list (`space j l`) says who is
in voice, muted, or talking. Switching to another editor (`space j o`)
leaves voice in this one. Sound goes through your desktop's sound server (PipeWire or
PulseAudio), where quad's streams can be routed and turned up or down, or
on macOS through Core Audio, to the input and output System Settings
choose; there is no echo cancellation yet, so use headphones. The speech travels
as Opus over the same iroh connection, beside the editor's protocol
([docs/design.md](docs/design.md#voice)).

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
toolchain has the layout). It needs only the host's C library at run time
(on Linux it runs on the host's dynamic linker, not the toolchain's: see
docs/design.md), and on macOS the system's frameworks. It allocates with
mimalloc, which overrides malloc for C, Chez Scheme and Rust alike. The
full Chez compiler is in it, so extensions are compiled, not interpreted.

A release build (`buck2 build -m release :quad`) is 22 MB, most of it the
Rust half's iroh stack. The executable is stripped: its symbols and what
debug info its link has are in `:quad[debug]`, `quad.debug` beside it,
which it names (`.gnu_debuglink`) for gdb, lldb and perf. The rest of the
debug info never reaches it (split DWARF, in debug builds: see
`buck/toolchains/cxx`); `:kernel[dwp]` packs all of it into one file. To
debug a debug build, from the repository root: `gdb -ex 'symbol-file
QUAD.debug' QUAD`. A Mach-O executable names no debug file, so on macOS
lldb is told it: `lldb -o 'target symbols add QUAD.debug' QUAD` (its debug
info stays in the objects, which the symbols point at). The link drops the
sections nothing refers to (`--gc-sections`, or `-dead_strip`), a quarter
of the code.

`quad --build-exe OUT FILE...` writes a new standalone editor: a copy of
itself with `FILE...` compiled into one more boot file, whose code runs as
the editor boots. That is how a configured editor becomes one binary to hand
out; `defs.bzl`'s `quad_executable` does the same from Buck, and
`:quad-custom` builds `docs/examples/site.ss` into one.

`buck2 install :quad` puts the executable in `~/.local/bin`, and `etc/`'s
desktop entry and icon, for Linux's application launchers, in `~/.local/share`
(the installer is `buck/installers/prefix`; `-- --prefix DIR` installs
under DIR instead). A file is replaced whole, so a running quad keeps its
old executable. The entry runs `quad` from the session's `PATH`, with
`--gui`, so it opens a window on the running editor when one listens, as
`quad --gui` from a terminal does.

## macOS

quad runs on macOS as it does on Linux. A window needs macOS 26 or later
on Apple silicon, for Metal 4, and a login session at the Mac (one over ssh
reaches no window server, so quad uses the terminal there); it opens on the
running editor, or detaches from the terminal, as on Linux. It has the
system's clipboard but no primary selection; Option types the characters
the keyboard's layout gives it, as macOS terminals take it; and the menu's
Quit (⌘Q), the Dock's and logging out close every window as their close
buttons do, so that the editor stops as it would then. Text is 13 points,
ghostty's size there, where a point is a logical pixel. `QUAD_NO_DISPLAY=1`
keeps quad from opening a window, here or on Linux.

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

quad edits with Ki's keys, or Vim's, or Helix's: a *key scheme* each, an
extension's (`core/ext/ki.sls`, `vim.sls`, `helix.sls`). Pick one with
`space j s`, or in the init file:

```scheme
(set-var! 'key-scheme 'vim)     ; or 'helix, or 'ki (the default)
```

Every scheme has quad's space menu (`space /` lists every key), panes
(`ctrl+w`), insert mode and prompts; what an init file binds in
`normal-keymap` wins in all of them. Vim's has its motions (`h j k l`, `w b
e`, `0 ^ $`, `gg G`, `f t F T ; ,`, `{ }`, `%`, `H M L`), counts, the
operators `d c y > < g~ gu gU` with a motion, a text object (`iw aw ip`,
`i( a( i" a"` and the other pairs) or themselves (`dd yy cc`), `x X D C s S
Y p P J r ~ u ctrl+r`, visual mode (`v V`), search (`/ ? n N * #`) and ex
commands (`:w :q :wq :e FILE :N :bn :sp :vs :reg`), registers (`"a` to
`"z`, `"A` appending, `"0` the last yank, `"1` to `"9` deleted lines, `"-`,
`"_`), macros (`qa` … `q`, `@a`, `@@`, a count) and `.`, which repeats the
last change (`3.` with a new count); not yet marks or replace mode. A macro
does not stop where a motion fails, as Vim's does: give it the count it
needs. Helix's selects first, every motion acting on every
selection: `w b e` select words, `x` lines, `%` everything, `v` extends, `;
alt+; ,` collapse, flip and keep the primary, `C` adds a cursor below, `s`
selects what a pattern matches, `alt+s` splits lines, `d c y p P R` act on
what is selected (in register `x` after `"x`), `Q` records a macro until
`Q` again and `q` plays it, `g` goes places (`gg ge gh gl gs`, `gd gr` with a
language server), `m` matches (`mm`, `mi( ma(`, `ms md mr` surrounds), `/ ? n
N *` search and `:` runs ex commands. Each scheme has its own tutor: `quad
--tutor` (or `space k h`) teaches the keys in use.

The rest of this section is Ki's keys, on QWERTY. A *selection mode* says what the units of
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
| `n` | local menu: `n d` search for text, `n e` for a regular expression (Rust's `regex` syntax; smart case), `n f` search the selection, `n n` all occurrences; with a language server, `n x` definition, `n v` references, `n a` diagnostics (below) |
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
| `space` | menu: `space space` command palette, `space e` eval, `space k d` files, `space k f` buffers, `space k g` grep the files, `space ;` explorer, `space /` every key, `space j v` quit, `space a` the agent (below) |
| `ctrl+w` | panes, as Vim and Helix have them: `v` split right, `s` split below, `q` close, `o` only this one, `w` next, `j` `l` `i` `k` (or the arrows) the pane that way, `+` `-` grow and shrink; a click focuses a pane |

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
`docs/examples/init.ss` shows more.

### Buffers that show things

An extension can show a list, a report or a tree as a buffer whose text it
renders, with regions over it that carry properties: a face to draw the
text in, keys that act on what is under the cursor, and the thing itself.

```scheme
(define file-keys (make-keymap 'file "File"))
(define-key file-keys "enter" 'open-it "Open")   ; (data-at-point): the file
(define b (rendered-buffer! "*files*" 'text))    ; read-only, made once
(buffer-render! b
  (span '((face . ui.text.focus)) "Files\n")
  (map (lambda (f) (span `((item . #t) (data . ,f) (keymap . ,file-keys)) f "\n"))
       (project-files (current-directory) 100)))
(switch-to-buffer! b)
(set-selection-mode! b 'item)                    ; movements step item to item
```

Rendering again keeps each cursor on the item it was on. Regions work in
any buffer (`buffer-add-region!`, `regions-at`, `region-property`), and
move with its edits.

What is not text -- a chart, a form, a game -- is a component: shown in a
pane of its own, it draws itself on a canvas the pane's size and takes the
keys it wants while focused (the others still reach `space` and `ctrl+w`).

```scheme
(define count 0)
(show-component! (current-client)
  (make-component 'counter
    (lambda (canvas focused?)           ; draw; return a cursor, or #f
      (put-string! canvas 0 0 (format "count: ~a" count) (ui-face 'ui.text))
      #f)
    (lambda (key text)                  ; a key (and what it types): taken?
      (and (string=? key "+") (begin (set! count (+ count 1)) #t))))
  'right)                               ; beside the focused pane
```

### Widgets, overlays and forms

What the editor draws over its panes -- pickers, dialogs, menus, popups,
the key legend -- is drawn from widgets (`core/widget.sls`), and an
extension draws from the same ones, in a component or in an overlay of its
own over the panes (`show-overlay!`, `make-overlay`: where it goes, its
widget, the keys it takes):

| | |
| --- | --- |
| layout | `framed` (a border and titles), `stack`, `beside`, `rule`, `vrule`, `padded`, `centered` |
| text | `text-lines`, `input-line`, `text-area` |
| data | `item-list`, `table`, `tree` (with `tree-rows`), `tabs`, `key-grid` |
| state | `progress`, `spinner`, `scrollbar` |
| controls | `checkbox`, `choice`, `button`, `text-field` |

A form (`core/form.sls`) is fields that take keys, shown as an overlay:

```scheme
(show-form! "New Branch"
            (list (text-input 'name "Name" "")
                  (toggle 'push "Push it" #f)
                  (choose 'from "From" '("main" "here") 0))
            (lambda (values) (message "~s" values)))  ; ((name . "...") (push . #t) (from . "here"))
```

### Testing your configuration

`quad --test` runs the `.ss` files in `tests/` beside the init file
(`~/.config/quad/tests/`), or the files named after it, in an editor with
no window or terminal and your init file loaded. A test drives the editor
as a client would and checks what happens:

```scheme
(headless-start! 12 60)                ; a client, 12 rows by 60 columns
(headless-buffer! "hello world" 'text) ; a buffer for it to show
(set-sels! (current-buffer) (list (make-sel 0 5)))
(press! "ctrl+u")
(expect-equal "ctrl+u shouts" (buffer-contents) "HELLO world")
(redraw!)
(check "the status line counts lines" (on-screen? "1 lines"))
```

Each check prints `ok` or `FAIL`; the run ends with how many passed and
failed, and exits 1 if any failed, so it can guard a dotfiles repository's
CI. `quad -q --test` leaves the init file out. The testing library
(`core/testing.sls`) has the rest: `press!` and `type!` for keys, `screen`
and `screen-row-of` for what a client shows, `run-until` to wait for a
process or a timer, `test-temp-dir` and `write-file!` for files.
`docs/examples/tests/init.ss` tests `docs/examples/init.ss`.

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

The Rust half is a crate for each part, each built and tested on its own,
so that a change to one rebuilds it and the few above it:

| Crate | Holds | Over |
| --- | --- | --- |
| `kernel/timing` | startup's steps, timed (`QUAD_TIMING=1`) | |
| `kernel/text` | buffer text (a rope), and searching it | |
| `kernel/files` | a project's files, and grep | |
| `kernel/image` | PNGs, decoded and scaled | |
| `kernel/mesh` | editors and clients over iroh | |
| `kernel/voice` | voice over iroh | mesh |
| `kernel/font` | fonts, shaping, Slug's curves, color emoji | image, timing |
| `kernel/render` | drawing frames: Vulkan, Metal 4 | font, image, timing |
| `kernel/gui` | windows, their screens, screen readers, the main thread | render, font, image |
| `kernel/lib.rs` | `(quad native)`: the procedures Scheme calls | all of them |

It is written with the `chez` crate (`kernel/chez-rs/`). Each
`#[chez::procedure]` is an ordinary Rust function that becomes a Scheme
procedure in `(quad native)`, which the build generates from the Rust:

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
`core/ext/blake3.sls` (`space l h`) and `tests/native.ss` use these. Nothing is
registered by hand, and there are no pointers in sight.

Subprocesses are a component too, `spawn-process`, with pipes to and from
the program; Scheme polls and reads its output's descriptor like any other.
`core/jsonrpc.sls` speaks JSON-RPC to such programs: a message per line, as
Codex's app server and MCP servers do, or after a `Content-Length` header,
as language servers do.

## Extensions

`core/ext/*.sls` are the libraries `(quad ext NAME)`, each a `chez.library`
target of its own; `EXTENSIONS` in `BUILD` picks the ones the editor is built
with, and the generated program invokes each as the editor boots, which is
when it registers its modes, commands and keys. The built-in ones are `lisp` (Scheme and other Lisps: s-expressions
for the NODE mode, Lisp indentation), `c` (C-like languages), `shell`
(`#`-commented languages), `markdown`, `blake3`, `codex`, the agent, `lsp`,
language servers, `people`, working together, `voice`, talking, and
`tutor`, whose lessons are `core/ext/tutor.md` (and `tutor-vim.md`,
`tutor-helix.md` for those keys), compiled in (`EXTENSION_DATA`
in `BUILD` gives an extension files to include as it compiles).

## Layout

| File | |
| --- | --- |
| `kernel/kernel.c` | boots Chez from the appended boot files; termios, poll, SIGWINCH |
| `kernel/lib.rs`, `kernel/*/` | the Rust half: `(quad native)`'s procedures, subprocesses, and a crate for each part (above) |
| `core/kernel.sls` | the kernel's primitives, bound for Scheme |
| `core/text.sls`, `kernel/text/` | buffer text: a rope (ropey) in the kernel, read through a window here |
| `kernel/text/search.rs` | searches of a buffer's text: regular expressions or literal text, over the rope (`regex-cursor`) |
| `kernel/files/`, `core/ext/grep.sls` | a project's files (what its ignore files leave: `ignore`), and searching them as you type (`space k g`) |
| `core/buffer.sls` | buffers, the views of them (selections, modes, scroll), undo, files |
| `core/syntax.sls` | the highlighting lexer and the node tree |
| `core/selection.sls` | selection modes and movements |
| `core/event.sls` | input events, as clients report them |
| `core/editor.sls` | the core and extension API, gathered from `client.sls` (clients, messages, variables, hooks), `keymap.sls` (commands, keymaps) and `prompt.sls` (prompts, popups, layers): buffers, selections, events |
| `core/commands.sls`, `core/edit.sls`, `core/input.sls` | the standard commands and the menus every key scheme shares; editing; the mouse, pastes and scrolling |
| `core/display.sls` | drawing each client's frame, sent as changed cells |
| `core/canvas.sls`, `core/widget.sls` | grids of cells to draw on, and the widgets frames, overlays and components are drawn from |
| `core/form.sls` | forms: fields that take keys, shown as overlays |
| `core/protocol.sls` | the client protocol: MessagePack frames, events as messages |
| `core/server.sls` | the event loop over descriptors, sockets, client messages |
| `core/grid.sls` | a client's model of its screen |
| `core/json.sls`, `core/jsonrpc.sls` | JSON, and JSON-RPC with a subprocess |
| `core/term.sls`, `core/tui.sls` | the terminal client: input decoding, painting, in-process or over a socket |
| `core/ext/ki.sls`, `vim.sls`, `helix.sls`, `vi.sls` | the key schemes: Ki's keys, Vim's, Helix's, and what the last two share |
| `core/frontend.sls` | what clients share: extensions' messages and capabilities, diverting a client's input |
| `core/face.sls` | faces and themes (the default is Helix's purple) |
| `core/ext/mesh.sls`, `kernel/mesh/` | editors and clients over iroh (`iroh-mesh`), a transport for `server.sls` |
| `core/ext/project.sls` | projects: `.quad/` configuration, trust, review |
| `core/main.sls` | the command line, `--build-exe` |
| `core/testing.sls` | headless clients for tests and `--batch` scripts |
| `core/ext/*.sls` | the built-in extensions |
| `etc/` | the desktop entry and icon |

The Scheme builds with the Chez Scheme toolchain (`buck/toolchains/chez`):
`:core` and each `:ext-*` are `chez.library` targets, compiled against their
dependencies' objects, so changing an extension recompiles that extension
and what is built from it, not the core. `:program`, `:boot` and `:quad`
are the program, its boot file and the standalone executable.

The tests (`tests/*.ss`) run with `quad --batch`, as headless clients that
keep a model of their screen from the server's messages, as any client does;
`tests/clients.ss` has several at once, and `:test-remote` runs a daemon with
clients in other processes. `:test-gui-render` draws frames as the window
does, with no window, and checks them against the cells (on Mesa's
lavapipe where it is installed, else on any device, Metal's on macOS;
skipped where nothing can draw), and `:test-golden` draws scenes and
compares them with the images in `tests/golden` (on lavapipe, or Metal).

## Credits

The window (`--gui`) draws text with the [Slug] algorithm, by Eric Lengyel:
its shader (`kernel/render/gui.slang`) is his reference shader, ported to Slang.
Slug shader code Copyright 2017 by Eric Lengyel, MIT OR Apache-2.0. Its
default font, built in, is [JetBrains Mono](https://www.jetbrains.com/lp/mono/),
Copyright 2020 The JetBrains Mono Project Authors, under the SIL Open Font
License 1.1.

[Chez Scheme]: https://cisco.github.io/ChezScheme/
[Slug]: https://github.com/EricLengyel/Slug
[Ki]: https://ki-editor.org
