<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GCC 4.7.4

GCC 4.7.4 is the first C++ compiler in the chain. The rebuilt GCC 4.0.4
builds stage 1; stage 1 builds stage 2, and stage 2 builds stage 3. Each stage
builds its generators, libiberty, libcpp, libdecnumber, zlib, the C and C++
compilers and the drivers with its predecessor, links them against the
predecessor's runtime, and then builds its own target runtime with the new
compiler: libgcc, libgcov and the startup objects. The C++ libraries live in
[libstdcxx](../libstdcxx/README.md). No configure or Make process runs.

GNU tar 1.12 extracts the archive with `--numeric-owner`. `sources.bzl` names
the objects each part compiles and the archive files they read. Every compile
uses stable logical source paths, and the flags fix the time macros and
random seed and drop debug information, so the stages can be compared. Stage
1 compiles the compiler without `-Werror`, as upstream's bootstrap does,
because GCC 4.0 warns about GCC 4.7's diagnostic format attributes; stages 2
and 3 use it.

## Regenerated sources

The archive's generated files are comparison fixtures, never compiler inputs.

- `libcpp/ucnid.h` comes from GCC's own `makeucnid.c` over the Unicode 4.0.1
  data and matches the shipped file. The generator's copyright string is
  updated to the header's 2009 notice, and a bounds fix stops its final flush
  from reading past the tables.
- The CRC table comes from the generator in `libiberty/crc32.c`'s own comment
  and, joined with the handwritten parts, matches the shipped file.
- `generators/decDPD.c` and its preamble come from live-bootstrap revision
  `dd8ac27bf959344b9bcf5e876bdd7716879bbc70`. Cellar fixes eight-bit parameter
  truncation, omitted output rows and uninitialized entries, and every value
  matches the shipped `decDPD.h`.
- `generators/bid-tables.c` rebuilds `bid2dpd_dpd2bid.h` from the regenerated
  DPD mappings and power-of-ten reciprocals computed with GMP, keeping
  upstream's precision choices, and every value matches the shipped header.
- The option, machine-description and garbage-collector generators write the
  rest. `gencondmd` runs to evaluate instruction conditions, and Flex
  regenerates gengtype's scanner.

`patches/` holds the musl target changes and a few local fixes; its
[README](patches/README.md) describes each one. `remove_gperf_dependency.patch`
drops the gperf-generated C++ library-name lookup.

## Compilers and runtimes

The target is static x86_64 musl only. `:stageN-xgcc` and the other drivers
take their assembler, linker and runtime through `-B`, and a missing tool is
an error even when the host has one on `PATH`. The option files include
upstream's `gnu-user.opt`, which supplies `-pthread`. Split stacks are
rejected, because the x86 implementation assumes glibc's TLS layout. The
runtime uses musl's `ucontext_t`, finds unwind tables with `dl_iterate_phdr`
and uses strong pthread references.

`:stageN-bootstrap-gcc` compiles each stage's runtime without depending on it.
`:stageN-gcc` is each stage's finished C compiler and `:stageN-link-runtime`
what it links around a program. The driver adds upstream's x86 startup files:
`crtfastmath.o` for `-Ofast` and `-ffast-math`, and `crtprec32.o` to
`crtprec80.o` for `-mpc32` to `-mpc80`.

## Tests

Each stage checks that its regenerated Unicode, CRC and decimal tables match.
Stage 1 checks libiberty, the preprocessor, decimal arithmetic, machine modes,
RTL construction, generator diagnostics, C and C++ at `-O0` and `-O2`, driver
compilation, preprocessing and missing-tool errors, and its runtime: static
linking, 128-bit and complex arithmetic, extended floating point, unwinding,
threads, math, Unicode and a gcov round trip. Stages 2 and 3 run the runtime
and coverage checks again, and every stage checks its floating-point startup
modes and `-pthread`.

`:stage-comparison` compares every stage 2 and stage 3 host and target runtime
object byte for byte, with libgcc and libgcov, except `cc1-checksum.o` and
`cc1plus-checksum.o`, which encode their predecessor's link inputs.
`audit-gcc-comparison.py` checks that inventory against Buck's object targets:

```
buck2 uquery 'kind("c_object", set(cellar//bootstrap/stage1/gcc47: cellar//bootstrap/stage1/libstdcxx:))' --json > /tmp/gcc-objects.json
buck2 uquery 'kind("command_test", set(cellar//bootstrap/stage1/gcc47: cellar//bootstrap/stage1/libstdcxx:))' --output-attribute=args --json > /tmp/gcc-tests.json
python3 cellar/bootstrap/audit-gcc-comparison.py --objects /tmp/gcc-objects.json --tests /tmp/gcc-tests.json
buck2 test cellar//bootstrap/stage1/gcc47:
```
