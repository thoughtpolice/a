<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lean language server

`lean --server` runs `$LAKE setup-file <file> -` for every file it opens
and reads back where each imported module's files are. `lake` here answers
that from Buck: it finds the target owning the file, builds the file's
import closure, and prints the paths Buck built. Lake never runs.

| File | Role |
| --- | --- |
| `bin/lean` | put on an editor's PATH; for `--server` it runs `lake serve`, otherwise the real `lean` |
| `lake` | the Lake stand-in: `setup-file`, `serve`, `src-path` |
| `lean.bxl` | the Buck queries `lake` makes |

`lake serve` builds every Lean module in the repository, then execs
`lean --server` from the Lean that Buck builds with (the one
`toolchains//lean:check` found), not whichever is first on the editor's
PATH, with four variables set:

- `LAKE` names `lake` itself.
- `LEAN_SRC_PATH` lists the source root of every Lean target. The server
  takes module names, go-to-definition targets and import completion from
  it.
- `PATH` starts with that Lean's `bin`, for the workers and `lake`.
- `LEAN_PATH` starts with a directory of links to every module's .ilean,
  under `~/.cache/depot-lean-lsp/`. The server reads them all when it
  starts, which is how find-references reaches files nobody has opened.

`lean.bxl:index` does the building and finds the roots. A module that does
not build is left out of the index with a note in the server's log, rather
than keeping the server from starting.

The server loads .olean files and precompiled libraries that Buck's Lean
wrote, and a different Lean fails on them.

## Setup

The repository configures three editors. Each needs `buck2` on its PATH,
which the Nix shell (direnv) provides.

| Editor | Where | How |
| --- | --- | --- |
| VS Code (vscode-lean4) | `.vscode/settings.json` | `lean4.envPathExtensions` puts `bin/` ahead of the Nix shell's lean |
| Helix | `.helix/languages.toml` | `[language-server.lean]` runs `lake serve` from here |
| Zed (the Lean 4 extension) | `.zed/settings.json` | `lsp.lean4-lsp.binary` runs `lake serve` from here |

Helix and Zed start servers in the workspace root and find this
directory through `buck2 root`.

Helix since workspace trust (#15177, 2026-03) reads `.helix/` only for a
trusted workspace, and the grant covers a hash of that directory, so any
change to `.helix/` needs trusting again. Until then it starts the stock
`lake serve` from PATH, which reports `unknown module prefix` on every
import from another Buck target. Run `:workspace-trust` once in the
repository (and again after `.helix/` changes), or list the checkout under
`[editor.workspace-trust] trusted` in your own config.

Any other editor works the same way: run
`buck/toolchains/lean/lsp/lake serve` as the Lean server, or put `bin/`
ahead of the Nix shell's lean on PATH. No lakefile may sit at the
workspace root; with one, editors start `lake serve` from the Nix shell
instead.

## Behaviour

- Opening a file builds its imports. So does editing its header, and
  "Restart File". Each runs two `buck2 bxl` calls, which take a fraction of
  a second when nothing needs building. Buck's output stays hidden unless
  the build fails, in which case it shows as an error on the file.
- The server asks for builds only on "Restart File" and passes `--no-build`
  otherwise. `lake` ignores that and builds every time.
- A file that belongs to no Lean target gets exit status 2, and the server
  falls back to LEAN_PATH.
- The setup carries the target's `package`, `options` and precompiled
  libraries, so the editor elaborates the way the build does.
- The index is as fresh as the server. References to code built after the
  server started appear once it restarts ("Restart Server" in VS Code);
  files open in the editor are always current.
- The first start after a large change waits for that build.
- `buck2` runs in the default daemon. Set `BUCK_ISOLATION_DIR` in the
  editor's environment to use another.
