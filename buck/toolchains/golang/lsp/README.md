<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Go language server

gopls finds packages with the go command, which knows nothing about Buck.
No go.mod names a module here, and a Go target's package is whatever its
BUILD file says. When `GOPACKAGESDRIVER` names a program, gopls asks that
program about packages instead, and `driver` answers from Buck. The `gopls`
script here starts gopls with that driver.

| File | Role |
| --- | --- |
| `gopls` | the command an editor runs as its Go language server; builds gopls and the driver, then runs gopls with any arguments given (`gopls check FILE` works too) |
| `driver.go` | the `GOPACKAGESDRIVER`, which turns gopls's queries into Buck's answer |
| `gopls.bxl` | the Buck queries the launcher and the driver make |
| `defs.bzl`, `modbuild.go` | build gopls from its module and pinned dependencies, offline |
| `gopls.bzl`, `lock.go` | the pins, and the program that writes them |
| `tests/`, `smoke_test.py` | the targets the smoke test opens over LSP, and the test |

The launcher runs gopls with four variables set:

- `GOPACKAGESDRIVER` names the driver.
- `GOROOT` and `PATH` point at the Go distribution Buck builds with. gopls
  runs `go env` and `go version` at start and needs this `go`, not whichever
  one the Nix shell puts first.
- `GOTOOLCHAIN=local` stops that `go` from fetching another toolchain.

## How the driver answers

- Each `go_binary`, `go_library` and `go_test` is one package, with the
  target's label as its ID. Its files and imports come from the `go list`
  analysis that Buck's own build made of it, so build constraints and
  `srcs` decide membership the way they do for the build.
- An import resolves to a `go_library` the target depends on, then to
  golang.org/x, then to the stdlib. The last two come from the
  `go_x_library` every Go target depends on (see ../x), through its
  `GoImportableInfo` provider.
- Every Go target here builds in one configuration, since the platforms
  turn cgo off for all of them (buck/platforms/BUILD) and the repository
  allows no build tags. So there is one copy of the stdlib, golang.org/x
  and each library, and a type from `io` matches itself everywhere.
- A file no Go target owns still gets a package, holding the file and an
  error on its first line that says so. Its stdlib and golang.org/x imports
  resolve.
- Imports added in the editor resolve before the file is saved. The driver
  reads them from the unsaved buffer that gopls passes along.

## Setup

The repository configures one editor and two coding agents. Each runs
`gopls` from this directory, found through `buck2 root`, so `buck2` has to
be on its PATH (the Nix shell provides it).

| Client | Where | How |
| --- | --- | --- |
| Helix | `.helix/languages.toml` | `[language-server.gopls]` |
| Claude Code | `.claude/marketplace/lsp/.lsp.json` | the `depot-lsp` plugin, enabled in `.claude/settings.json` |
| OMP | `.omp/lsp.json` | `servers.gopls`, which takes the place of OMP's built-in gopls |

Each sets gopls's `directoryFilters` to `-buck-out`, `-work` and
`-**/node_modules`. The stdlib and golang.org/x sources live under
buck-out, and gopls would otherwise diagnose all of them as part of the
workspace. The clients hand gopls its settings in different ways, so each
file has its own copy: Helix's `config`, Claude Code's
`initializationOptions`, and OMP's `initOptions` and `settings.gopls`. OMP
also pushes `settings`, and without its own would push those of its
built-in gopls, which turn on gofumpt and staticcheck. The smoke test fails
if the copies differ, or if the clients start gopls differently.

Claude Code drops every location in a file that git ignores. So there,
definitions and references stop short of the stdlib and golang.org/x, whose
sources live under buck-out.

Helix also roots Go files at `.buckroot` instead of the nearest go.mod.
Only the stdlib and golang.org/x under buck-out have a go.mod, and with the
default Helix adds a workspace folder for one whenever you jump to a
definition there.

Any other editor works the same way. Run `buck/toolchains/golang/lsp/gopls`
as the Go language server and set the same `directoryFilters`. An editor
that adds a workspace folder at a dependency's go.mod still works, since
the driver answers for files of the stdlib and golang.org/x, but gopls then
keeps a second view.

## Behaviour

- The first start downloads 138 pinned files and builds gopls from source,
  about half a minute. Later starts take a fraction of a second.
- At start gopls asks for `./...`. The driver lists the .go files under the
  workspace root and asks Buck which targets own them. It skips what the go
  command skips (testdata, names starting with `.` or `_`), buck-out,
  nested Buck projects and the project's `work/`. In this repository that
  is about 40 targets, answered in 0.1 to 0.2 seconds once Buck has
  analyzed them.
- A target's import path is its `package_name`, or else its package's path
  in its cell: `toolchains//golang/lsp/tests/greeting` is
  `golang/lsp/tests/greeting`. When gopls reloads a package by import path,
  the driver looks in the directory of that name in every cell, so it finds
  a target with a different `package_name` only through its files.
- A file in several targets, such as a binary and its tests, belongs to
  each of their packages. gopls diagnoses all of them.
- A new file belongs to no target until a BUILD file lists it or it is
  saved where a glob picks it up.
- A `go_bootstrap_binary` tells Buck only its file names, so the driver
  picks its files by build constraint and reads its imports itself. It
  builds from the stdlib alone.
- `buck2` runs in the default daemon. Set `BUCK_ISOLATION_DIR` in the
  editor's environment to use another.

Some things the driver does not cover:

- Files that import "C" show as ignored, as the build ignores them with
  cgo off.
- External test files (`package foo_test`) show as ignored. Buck's go_test
  does not build them either.
- Targets incompatible with the default platform are left out.

## Updating gopls

Change `GOPLS` in BUILD, then rewrite the pins:

```sh
buck2 run toolchains//golang/lsp:lock -- -w buck/toolchains/golang/lsp/gopls.bzl
```

`lock.go` downloads the module, reads its go.sum, and records the sha256 of
every go.mod and module zip that go.sum lists. Building `:gopls` against a
stale lock fails with that command in the error. The build itself runs the
go command with `GOPROXY=file://` over those files, `GOSUMDB=off` and
`-mod=readonly`, so it fetches nothing and the go command still checks every
file against go.sum.
