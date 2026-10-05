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

`lake serve` sets `LAKE` to itself and `LEAN_SRC_PATH` to the source root
of every Lean target (found through `lean.bxl:roots`), then execs
`lean --server`. The server takes module names, go-to-definition targets
and import completion from `LEAN_SRC_PATH`.

The `lean` it runs is the one Buck builds with, the one
`toolchains//lean:check` found, not whichever is first on the editor's
PATH. Its `bin` goes first on the server's PATH too, for the workers. The
server loads .olean files that Lean wrote, and a different Lean fails on
them.

## Setup

VS Code picks up `bin/lean` from the repository's `.vscode/settings.json`:

```json
"lean4.envPathExtensions": ["buck/toolchains/lean/lsp/bin"]
```

Other editors need `buck/toolchains/lean/lsp/bin` ahead of the Nix
shell's lean on PATH, or `lake serve` as the server command. No lakefile
may sit at the workspace root; with one, editors start `lake serve` from
the Nix shell instead.

## Behaviour

- Opening a file builds its imports. So does editing its header, and
  "Restart File". Each runs two `buck2 bxl` calls, which take a fraction of
  a second when nothing needs building. Buck's output stays hidden unless
  the build fails, in which case it shows as an error on the file.
- The server asks for builds only on "Restart File" and passes `--no-build`
  otherwise. `lake` ignores that and builds every time.
- A file that belongs to no Lean target gets exit status 2, and the server
  falls back to LEAN_PATH.
- The setup carries the target's `package` and `options`, so the editor
  elaborates with the settings the build uses.
- `buck2` runs in the default daemon. Set `BUCK_ISOLATION_DIR` in the
  editor's environment to use another.
