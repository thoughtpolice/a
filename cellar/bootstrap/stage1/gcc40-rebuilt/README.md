<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GCC 4.0.4 rebuilt with musl 1.2.5

The first GCC 4.0.4, as `musl12:gcc`, builds GCC 4.0.4 again against
[musl 1.2.5](../musl12/README.md). BUILD calls the `gcc40_stage` macro from
[gcc40](../gcc40/README.md), so a GCC rebuilds every generator, library,
compiler object and driver that TCC built there, from the same patches, tests
and generator sources. No configure or Make process runs.

A GCC predecessor evaluates GCC's instruction conditions at compile time, so
the early generator headers include the regenerated `options.h`, and the RTL
test checks that the condition table is populated. Generator and compiler
objects use `-O2`. Generated sources keep their names, such as `genrtl.c`,
because GCC's driver chooses the language from the file name.

The new compiler builds its own libgcc, libgcov, `crtbeginT.o` and `crtend.o`,
without the TCC varargs helpers. It runs on musl 1.2.5 and targets it.
`:link-runtime` is what it links around a program. `:separate-link-runtime`
keeps the separate-archive test's link line, which puts this build's libgcc
between the first GCC 4.0.4's `crtbeginT.o` and `crtend.o`.

## Tests

The tests match [gcc40's](../gcc40/README.md): source regeneration, generator
diagnostics, C at `-O0` and `-O2`, driver preprocessing and piped compilation,
static linking, separate archives and weak symbols, arithmetic helpers,
constructors, threads and TLS, forced and signal-frame unwinding, math,
Unicode, and failure when a declared tool, header or library is missing.

```
buck2 test cellar//bootstrap/stage1/gcc40-rebuilt:
```
