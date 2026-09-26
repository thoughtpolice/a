<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GCC 4.0.4 built with TCC

The final TCC, `tcc-native:tcc`, builds the gcc-core 4.0.4 C compiler against
musl 1.1.24's GNU-built libraries, with binutils 2.30 as the assembler and
linker. No configure or Make process runs.

`defs.bzl` declares the whole build as the `gcc40_stage` macro, which this
package calls once. It
covers libiberty and libcpp, the option, machine-description and
garbage-collector generators, the C front end, backend and drivers, and the
target runtime, which the new compiler builds itself: libgcc, libgcov,
`crtbeginT.o` and `crtend.o`. `sources.bzl` lists the archive's headers, and
the macro derives the other archive files from its object lists. The patches,
tests and `generators/ucnid.c` live in this package.

The generators run on the predecessor and write every generated source the
compiler uses. The archive's generated files are left out of the source tree
or kept as test fixtures. `generators/ucnid.c` is a C translation of
`libcpp/ucnid.pl`, and its `ucnid.h` matches the shipped one. Bison builds the
C parser from `c-parse.in` and gengtype's parser, and Flex builds gengtype's
scanner.

TCC built the input musl, which calls TCC's varargs helpers, so this libgcc
also holds a GCC-built copy of them, `tcc-libc-varargs.o`.

## Compilers and runtimes

The raw driver `:xgcc` needs explicit `-B` prefixes for its tools and runtime,
and fails when a tool is missing instead of searching `PATH`; GCC 4.0 has no
`--sysroot`. `:gcc` supplies those paths and the new runtime. TCC links the
generators and other predecessor-built programs with `tcc-native:link-runtime`,
and `:link-runtime` is what this compiler links around a program.

## Tests

The tests cover source regeneration, generator diagnostics, libiberty and the
preprocessor, C at `-O0` and `-O2`, driver preprocessing and piped compilation,
static linking, a separate archive with weak symbols, 128-bit and complex
arithmetic helpers, constructors, threads and TLS, forced and signal-frame
unwinding, math, Unicode, and failure when a declared tool, header or library
is missing.

```
buck2 test cellar//bootstrap/stage1/gcc40:
```
