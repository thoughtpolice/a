<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Rust language server

rust-analyzer finds crates through Cargo, and no Cargo.toml describes the
repository's Rust targets. Two settings hand that job to another program.
`workspace.discoverConfig` runs a command that answers with a
rust-project.json for the file being opened, and `check.overrideCommand`
runs one that prints rustc's diagnostics for the file being saved.
`rust-project` here does both, from Buck.

| File | Role |
| --- | --- |
| `rust-project` | the command the editors run; builds the Go program below with `buck2 run` and passes its arguments on |
| `main.go`, `project.go`, `check.go` | the program: `discover` for workspace discovery, `check` for check-on-save |
| `rust.bxl` | the Buck queries it makes, which also build what rust-analyzer reads |
| `tests/`, `smoke/` | the targets the smoke test opens over LSP, and the test |

It replaces the `rust-project` that buck2 ships under
`integrations/rust-project`, which the repository used to pin as a
DotSlash binary in `buck/bin`. That one tracks the prelude's
`rust/rust-analyzer` BXL, which calls it a private detail, so every buck2
update meant a new binary. This one reads the prelude's `RustAnalyzerInfo`
provider and nothing else of it.

## Commands

`rust-project discover ARG` takes the argument rust-analyzer puts in place
of `{arg}`, one of `{"path": FILE}`, `{"buildfile": BUILD}` and
`{"label": TARGET}`. It prints the discovery protocol's progress lines, then
one `finished` line with the project, or an `error` line.

`rust-project check FILE` prints one rustc JSON diagnostic per line for the
Rust targets that own FILE. `-clippy=false` asks for rustc's diagnostics
without clippy's lints.

Both run Buck in the Buck project holding the file.

## How it answers

- The targets that own the file, or those of the BUILD file or label, are
  the workspace. Up to 50 other Rust targets of the same BUILD files come
  along (`-max-extra`), as do the Rust tests the workspace lists in
  `tests`.
- Everything they depend on, transitively, is a crate too, proc macros
  included. A dependency through an alias names the crate the alias points
  at, since an alias forwards that crate's providers. A `named_deps` entry
  gives the local name.
- One `buck2 bxl` call answers, and also builds what rust-analyzer reads.
  That is each crate's source tree, generated sources, build script output
  (`OUT_DIR`) and proc macro dylibs.
- A test whose root module is a library's or binary's, or that names one
  with `unit_test_of`, becomes part of that crate. The build compiles the
  file twice, once with cfg(test), but rust-analyzer gives a file to one
  crate. The crate gets the test's dependencies, and its build label is the
  test's, so rust-analyzer's "Run Test" runs
  `buck2 run TEST -- NAME --exact --nocapture`.
- A crate's root module is the repository's own file, so the editor's path
  matches. A crate whose sources only Buck has, an extracted crate archive
  say, keeps the path inside its source tree under buck-out.
- Crates outside the third-party cell get cfg(test), so tests in any of
  them read as code rather than as disabled. Each crate's features and
  `--cfg` flags turn on the matching cfgs.
- The standard library comes from the toolchain's rustc: `rustc
  --print=sysroot` gives the sysroot, and rust-analyzer loads the library
  from its `rust-src` component.
- `check` builds the diagnostics output of every Rust target owning the
  file, the build's own compile with clippy by default, and makes the
  paths in it absolute. A library and its unit tests report a shared
  diagnostic once.
- `buck2` runs in the daemon the editor's environment selects. Give it the
  `BUCK2_SHARE_DAEMON` and `BUCK2_DAEMON_GROUP` that `.envrc` sets, so it
  joins the shell's shared daemon: a `buck2` outside that daemon cannot use
  the checkout while it runs.

Some things it does not cover:

- A test that shares no root module with anything and that no workspace
  target lists in `tests` loads only when one of its own files is opened.
- A dependency crate's cfg(test) code can name test-only dependencies the
  graph leaves out. Its errors show only when that file is open.
- Targets incompatible with the default platform are left out.

## Setup

The repository configures one editor and two coding agents. Each runs
`rust-project` from this directory, found through `buck2 root`, so `buck2`
and `rust-analyzer` have to be on its PATH (the Nix shell provides both).

| Client | Where | How |
| --- | --- | --- |
| Helix | `.helix/languages.toml` | `[language-server.rust-analyzer.config]` |
| Claude Code | `.claude/marketplace/lsp/.lsp.json` | the `depot-lsp` plugin's `initializationOptions` |
| OMP | `.omp/lsp.json` | `servers.rust-analyzer`, in both `initOptions` and `settings` |

The smoke test fails if the copies differ. Any other editor works the same
way. Give rust-analyzer the same `check.overrideCommand` and
`workspace.discoverConfig`.

## Testing

`buck2 test toolchains//rust/lsp:` runs the unit tests and the smoke test.
The smoke test runs `rust-project` as the configuration does, against the
crates under `tests/`, then starts rust-analyzer over LSP and looks up
definitions in a renamed library, a proc macro's output, a third-party
crate and the standard library, and saves a file to see its warning
arrive. Its Buck calls run in the shared daemon that runs the test, so
they read the checkout rather than declared inputs.
