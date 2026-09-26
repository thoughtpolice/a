<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native bootstrap stages

The packages under `stage1/` hold the typed rules for C programs and the
helpers those rules run, all built on stage0. This page describes the
principles the rules follow and the stages in the order they build. Each
package's README has the details.

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
for byte.

## Stages

### stage0

The [stage0](../stage0-posix/) packages grow the 229-byte hex0 seed into
M2-Planet, M2-Mesoplanet, the mescc-tools and mescc-tools-extra, and check each
program against upstream's SHA256 answers. M2-Mesoplanet also builds
[simple-patch](simple-patch/README.md) and the
[action helpers](tools/README.md) that rules run around a tool.

## Building and testing

From `cellar/`:

```sh
../buck/bin/buck2 build @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage1/...
../buck/bin/buck2 test @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage1/...
```

Each package also tests on its own, for example
`cellar//bootstrap/stage1/simple-patch:`. The [top-level README](../README.md)
describes the audits that check the build from outside.
