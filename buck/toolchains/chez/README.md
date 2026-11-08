<!--
SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Chez Scheme

Rules for Chez Scheme (`third-party//by-name/ch/chez-scheme`), in
`defs.bzl`:

```python
load("@toolchains//chez:defs.bzl", "chez")

chez.library(name = "core", srcs = glob(["core/*.sls"]), strip_prefix = "core", prefix = "app")
chez.program(name = "main", src = "main.ss", deps = [":core"])
chez.boot(name = "app", deps = [":main"])
chez.standalone(name = "app-bin", kernel = ":kernel", boots = [":app"])
chez.rust_library(name = "native", crate = ":native-rs", library = "native")
```

- `chez.library` compiles a target's libraries against its dependencies'
  compiled objects alone. A change recompiles the targets downstream of it,
  and no others. A target records its libraries in import order, in its
  `[manifest]`.
- `chez.program` compiles a top-level program.
- `chez.boot` makes a boot file of every library its dependencies need, each
  after what it imports, then their programs. `requires` is
  `["scheme", "petite"]` (the default, with the compiler) or `["petite"]`.
- `chez.standalone` appends Chez Scheme's boot files and the given ones to a
  kernel: one executable that needs no files beside it. The kernel is
  stripped first (`strip = False` keeps it whole): its symbols and debug
  info go into the `[debug]` sub-target, a file beside the executable that
  it names (`.gnu_debuglink`), so that debuggers and profilers find it.
- `chez.rust_library` generates the Scheme library binding a Rust crate's
  procedures (see the `chez` crate, `src/crates/chez`).

A kernel is a C program that links `:kernel` (Chez Scheme's runtime and
`scheme.h`) and boots from its appended boot files with `:embed`
(`chez_embed.h`). `tests/kernel.c` is the smallest one. `:embed-scheme` is
`(chez embed)`, for programs that write standalone executables themselves.

`tests/` builds a two-target library, a program, a boot file and a
standalone executable, and runs it.
