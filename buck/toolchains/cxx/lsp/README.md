<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# C and C++ language server

clangd learns how to compile each file from a compile_commands.json, which
nothing writes in a Buck repository. `clangd` here writes one from what Buck
builds with, then starts clangd with it.

| File | Role |
| --- | --- |
| `clangd` | the command an editor runs as its C and C++ language server; builds the wrapper below with `buck2 run` and passes its arguments on |
| `main.go`, `db.go` | the wrapper, which writes the compilation database and runs clangd |
| `clangd.bxl` | the Buck query it makes, which also builds what the commands read |
| `tests/`, `smoke/` | the targets the smoke test opens over LSP, and the test |

`clangd ARGS...` writes the database, then runs the clangd on PATH with
ARGS and two more:

- `--compile-commands-dir` names the database's directory, under the user's
  cache directory (`~/.cache/depot-clangd/`), one per checkout. clangd
  keeps its index there too, under
  `.cache/clangd`, so neither lands in the checkout.
- `--query-driver` names the compilers the commands run, so that clangd
  asks them for their own include paths. Nix's clang wrapper adds the
  standard library's and every package's headers to the command line it
  runs, which clangd would not otherwise see.

`clangd db` writes the database and prints its path, without starting
clangd. `clangd --check=FILE` runs clangd's own check of one file against
the fresh database.

## How it answers

- Every `cxx_binary`, `cxx_library`, `cxx_test` and
  `cxx_python_extension` in the root, toolchains, third-party and tilde
  cells has an entry for each of its sources and headers, with the command
  the build runs in the default platform. cellar is left out. A package
  that fails to load or a target that fails to configure or analyze is
  left out with a note on stderr, and a target incompatible with the
  default platform without one.
- One `buck2 bxl` call answers, and also builds what the commands read:
  their argument files, header trees and generated headers. The first
  start after a large change waits for that build.
- The prelude passes most flags in argument files, nested several deep.
  clangd reads those itself, but the database has them expanded, so that
  the wrapper can rewrite the include path inside them (below).
- A target's headers reach the compiler through a tree of links under
  buck-out (`buck-headers`), each at the path code includes it by. clangd
  would name a header by the link, so going to a definition would open a
  file under buck-out rather than the repository's. Where a link's target
  ends with the link's path, as it does for a header in the repository or
  in an extracted archive, the database names the directory above that
  path instead. A tree with other headers (generated ones, or renamed)
  stays on the include path after those directories.
- A source's own command comes before any header command for the same
  file.
- If writing the database fails, clangd still starts with the last one
  written, with a note on stderr.
- `buck2` runs in the daemon the editor's environment selects. Give it the
  `BUCK2_SHARE_DAEMON` and `BUCK2_DAEMON_GROUP` that `.envrc` sets, so it
  joins the shell's shared daemon: a `buck2` outside that daemon cannot use
  the checkout while it runs.

Some things it does not cover:

- The database is as fresh as the server. A new file or target, or a
  changed flag, takes effect once the server restarts.
- Generated headers live under buck-out, so their definitions do too.
  Claude Code drops every location in a file that git ignores, so there
  definitions stop short of them, and of third-party sources extracted
  from archives.
- A tree on the include path can hide a header name in the directories it
  stands for, which the build would not find. clangd then finds a header
  the build does not.

## Setup

The repository configures two editors and two coding agents. Each runs
`clangd` from this directory, found through `buck2 root`, so `buck2` and
`clangd` have to be on its PATH (the Nix shell provides both, from the
same LLVM as the clang the build uses).

| Client | Where | How |
| --- | --- | --- |
| Helix | `.helix/languages.toml` | `[language-server.clangd]`, which Helix's C and C++ languages use already |
| Claude Code | `.claude/marketplace/lsp/.lsp.json` | the `depot-lsp` plugin, enabled in `.claude/settings.json` |
| OMP | `.omp/lsp.json` | `servers.clangd`, which takes the place of OMP's built-in clangd |
| quad | `.quad/init.ss` | reads `.claude/marketplace/lsp/.lsp.json`, so it starts the server as Claude Code does |

The smoke test fails if they start clangd differently. Any other editor
works the same way. Run `buck/toolchains/cxx/lsp/clangd` as the C and C++
language server.

## Testing

`buck2 test toolchains//cxx/lsp:` runs the unit tests and the smoke test.
The smoke test writes the database through the launcher and checks the
entry of `tests/hello/main.cpp`, then starts clangd as the configuration
does, opens that file, waits for it to compile without errors, and looks up
definitions in the library's header, its generated header and the
standard library. Its Buck calls run in the shared daemon that runs the
test, so they read the checkout rather than declared inputs, and it uses a
temporary cache directory.
