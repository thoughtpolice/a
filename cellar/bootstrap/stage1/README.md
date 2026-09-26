<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native bootstrap stages

The packages under `stage1/` take the chain from MesCC to musl 1.1.24, with TCC
0.9.27 and a set of parser, scanner and macro tools linked against it, all
static x86_64 programs. This page describes the stages in the order they build
and how each one is checked. Each package's README has the details.

## Principles

- **BUILD declares every action.** Package BUILD files name each source,
  configuration header, generator run, compilation, archive and link. No
  configure script, Makefile or kaem script runs. The shared rules are in
  [actions.bzl](../actions.bzl) (`generate`, `configured_tool`, `command_test`,
  `compare_test`, `result_test`), [source.bzl](../source.bzl) (downloads,
  extraction, `exact_patch`) and [defs.bzl](defs.bzl) (`compiler`, `c_object`,
  `c_library`, `c_binary`, `link_runtime`).
- **Exact patches.** Each source change is a `.patch` file with one unified
  hunk, or short `before` and `after` strings in BUILD. The M2-built
  [simple-patch](simple-patch/README.md) applies it only if the original text
  occurs exactly once, and writes a new file.
- **Regenerated sources.** Parsers, scanners, tables and other generated files
  that a release ships are never compiler inputs. Declared actions regenerate
  them with bootstrapped tools. Where the generator and its input are the ones
  upstream used, a test compares the result with the shipped file.
- **Fixed points.** Mes and TCC 0.9.26 each rebuild themselves until the last
  two generations match.
- **Static programs.** Every program links statically. `c_binary` takes its
  startup objects, C library and compiler runtime from a `link_runtime`, so
  each link names every input. Compilers get explicit tool, header and library
  paths, and a missing header or library fails instead of falling back to the
  host.
- **Stable source paths.** With `source_tree`, compilations see their source as
  `source/...` inside the action, through the
  [source-alias helper](tools/README.md), so the same source compiles to the
  same bytes whatever the workspace path.

A check that runs as a build action writes `passed` once every check succeeds,
and `result_test` compares that file. `compare_test` compares two outputs byte
for byte. `rules-tests` checks the rules themselves, starting with MesCC and
TCC.

## Stages

### stage0

The [stage0](../stage0-posix/) packages grow the 229-byte hex0 seed into
M2-Planet, M2-Mesoplanet, the mescc-tools and mescc-tools-extra, and check each
program against upstream's SHA256 answers. M2-Mesoplanet also builds
[simple-patch](simple-patch/README.md) and the
[action helpers](tools/README.md) that rules run around a tool.

### Mes

M2-Planet builds the [Mes 0.27](../mes/) interpreter, which regenerates
[NYACC](../nyacc/)'s C parser tables from their grammars. MesCC, running on
that interpreter, builds Mes's C libraries and Mes again, three times over, and
`mes:mes-fixed-point` requires the last two interpreters to match.

### TCC

MesCC builds [TCC 0.9.26](tcc/README.md) from one amalgamated source against
Mes libc. That compiler builds TCC again with separate translation units, three
times, and `tcc:fixed-point` requires the last two generations' compiler,
libraries and startup objects to match. TCC 0.9.26 then builds
[TCC 0.9.27](tcc-release/README.md), still against Mes libc.

### musl 1.1.24

TCC 0.9.27 builds [musl 1.1.24](musl/README.md). [Sed 4.0.9](sed/README.md),
built with the same compiler, runs musl's header generators. In
[tcc-musl](tcc-musl/README.md), TCC 0.9.26 links TCC 0.9.27 against musl, and
that compiler rebuilds itself and musl. [musl-tables](musl-tables/README.md)
regenerates the Unicode, ctype and iconv tables from pinned data, and they
match every published value. The rebuilt TCC then compiles musl again with
them, as the `restored` pass.

### Parser and scanner tools

TCC and musl 1.1.24 build the tools that regenerate parsers and scanners:
[oyacc](oyacc/README.md), the [Bash 2.05b](bash-bootstrap/README.md) that runs
generator scripts, [Heirloom lex](heirloom-lex/README.md),
[Flex 2.5.11](flex-bootstrap/README.md) and [2.6.4](flex/README.md),
[Bison 3.4.1](bison/README.md), [m4 1.4.7](m4/README.md) and
[gawk 3.0.4](gawk/README.md). Flex and Bison regenerate their own scanner and
parser, and the result matches a further regeneration. `tools:libshell.a` gives
m4 and gawk a `system` and `popen` that run a declared shell.

## Building and testing

From `cellar/`:

```sh
../buck/bin/buck2 build @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage1/...
../buck/bin/buck2 test @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage1/...
```

Each package also tests on its own, for example
`cellar//bootstrap/stage1/tcc:`. The [top-level README](../README.md) describes
the audits that check the build from outside.
