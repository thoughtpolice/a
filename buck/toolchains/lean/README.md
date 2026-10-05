<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lean toolchain

Builds Lean 4 with Buck2, one action per module, without Lake. Lean comes
from the Nix dev shell (`buck/etc/nix/lean4.nix`), the same way the C++ and
Rust compilers do, so all three link through the same Nix linker wrapper.

## Rules

All of them are reachable as `depot.lean.*` from `@root//buck/shims:shims.bzl`.

| Rule | Produces |
| --- | --- |
| `library(name, srcs, deps, ...)` | the modules' .olean files, and a static C++ library of their code |
| `binary(name, srcs, deps, ...)` | a program; one of `srcs` defines `main` |
| `test(name, srcs, deps, ...)` | modules checked as a test, optionally a program run as one |

`srcs` are .lean files. A file's module name is its path below `root`
(default: the package directory), so `Foo/Bar.lean` is `Foo.Bar`. `deps`
take Lean libraries and C++ libraries alike: a C++ library there
implements `@[extern]` functions and is linked into every program using
the Lean library.

Lean attributes, shared by all three rules:

| Attribute | Default | Meaning |
| --- | --- | --- |
| `package` | target name | package id that Lean mangles into symbols (`lp_<package>_...`, `initialize_<package>_<Module>`) |
| `options` | `{}` | Lean options, e.g. `{"autoImplicit": False}` |
| `allow_sorry` | `False` | a `sorry` fails the build unless set |
| `warnings_as_errors` | `False` | sets `warningAsError` |
| `split_codegen` | `False` | generates code for `module` files in a separate `leanir` action (below) |
| `lean_flags` | `[]` | extra `lean` arguments |
| `compiler_flags` | `[]` | extra C compiler flags for the generated code |

`test` adds `leanchecker` (default on: replay the test's own modules
through the kernel), `executable` (build `srcs` into a program and run it),
`args` and `env`.

## How a library builds

1. One `lean --deps-json` action parses every source's import header.
2. A dynamic action reads that import graph and the graphs of all Lean
   dependencies, and declares the per-module actions below.
3. `lean --setup` elaborates each module and writes its IR and C. The
   setup file lists the exact .olean files of every module in the import
   closure, so Lean never searches LEAN_PATH; stdlib modules come from the
   toolchain's lib/lean. A failed proof fails here.
4. With `split_codegen = True`, a `module` file's step 3 stops at the
   .olean files, and `leanir` writes the IR and the C code afterwards
   (`compiler.postponeCompile`). An importer that is also a `module` then
   elaborates against .olean files only, so it starts before its imports'
   code generation finishes. Everything else waits for its imports' IR:
   code generation in step 3 needs it, and so do `meta` imports and
   `import all`. Lean marks this experimental, and it does not
   work for much real code yet. `leanir` reads only the `.ir.sig` of each
   import, and the toolchain's stdlib ships every `.ir.sig` as an empty
   placeholder, so code needing the code generator's data for a stdlib
   function fails (for example `Unknown constant
   List.replicateTR._redArg`). And code generated this way fails the IR
   check of an importer that does its own code generation in one step
   (`unknown join point`), so every target in an import closure has to
   agree. `tests:split-codegen` covers the case that works.
5. The C files go to a `cxx_library` (`<name>--native`) built by the C++
   toolchain with the flags `leanc` uses, against `:runtime`, which carries
   lean.h and the link flags of Lean's runtime and standard library.

`<name>` forwards the C++ library's providers along with
`LeanLibraryInfo`, so `cxx_binary` and `rust_binary` can depend on a Lean
library directly. `interop.cpp` in `tests/` calls Lean from C++ that way.
Lean's runtime archives are not position independent, so Lean libraries
link statically.

The subtargets of `<name>--lean` are `[Module.Name]` (its .olean, .ir.sig
and .ir directories), `[Module.Name.c]` and `[imports.json]`.

## Toolchain version

`:check` runs `lean --version` and compares it to the `version` in
`buck/etc/nix/lean4.nix`. It reruns whenever that file or the flake lock
changes, and every Lean action takes its output as an input, so a Lean
upgrade rebuilds all Lean code. If it fails after a Nix change, reload the
dev shell and restart Buck (`buck2 kill`) so actions see the new PATH.

## Editors

`lsp/` makes `lean --server` take each file's imports from Buck. See
[lsp/README.md](lsp/README.md).

## What is not here

- Lake packages. A third-party Lean package needs a `library` target, the
  way crates need reindeer; nothing generates those yet.
- Precompiled modules (`--plugin`/`--load-dynlib`). `@[extern]` functions
  and other compiled code from dependencies run in the interpreter during
  elaboration, and an `@[extern]` without an interpreter fallback cannot be
  `#eval`ed by its importers.
- `.ilean` indexing across the whole repository for find-references in the
  editor.
