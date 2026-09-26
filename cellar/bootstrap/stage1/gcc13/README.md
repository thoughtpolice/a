<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native GCC 13.5.0 bootstrap

GCC 13 follows GCC 10.5.0 and binutils 2.41 on live-bootstrap's route; this
package builds the 13.5.0 point release. GCC 13 is written in C++11, so GCC
10's C++ compiler and libstdc++ build the first stage. BUILD calls the shared
[GCC port](../gcc/README.md) for three stages with GNU binutils 2.41;
`config.bzl` holds the reviewed configure answers and `sources.bzl` the file
lists. The C++ standard library is in [libstdcxx13](../libstdcxx13/README.md).

## What differs from the shared port

- Every `gcc/` and libcpp source is C++ and named `.cc`, as are the sources
  the generators write.
- All Unicode inputs are the 15.0.0 files GCC ships in `contrib/unicode`.
  `makeucnid` now also reads the XID properties C++23 identifiers use.
- `libcpp/uname2c.h`, new in GCC 13, maps Unicode names to code points for
  `\N{...}` escapes. GCC's `makeuname2c` regenerates it, sorting its radix
  tree stably as the release's glibc build did.
- `cp/std-name-hint.h`, also gperf output upstream, comes from the shared
  `gperf.awk` too, with its own lookup test.
- `version.h` comes from GCC's `genversion`, which replaces the GCC 10
  `gcov-iov` generator and records no path.
- `cc1plus` links libcody for C++20 modules.
- `cc1` and `cc1plus` allocate through [mimalloc](../mimalloc/README.md)
  instead of musl's malloc, which unmaps and remaps pages hundreds of
  thousands of times per large translation unit. Their output is unchanged,
  and stages 2 and 3 compile about 15% faster. Each stage's host compiler
  builds that stage's `mimalloc.o`, and stages 2 and 3 compare it like every
  other object.
- libgcc adds the half-precision and bfloat16 conversions GCC 13 introduces,
  and the driver also links `crtfastmath.o` for the new `-mdaz-ftz`.

`auto-host.h` describes GNU binutils 2.41:

- The assembler and linker compress debug sections with zlib, which GCC 13
  calls level 1. Level 2 would add zstd, which the cellar binutils do not
  support.
- gas 2.41 accepts `--gdwarf-5` and writes the line table from the
  compiler's `.file` and `.loc` directives, so the driver passes `--gdwarf-N`
  for every `-g` compile. Each stage builds a `-g` program, and its debug
  line table must map `main` back to its C source line.
- ld no longer supports `-z bndplt`, and GCC 13 no longer emits stabs.
- musl 1.2.5 declares `basename` only in `<libgen.h>`, so libiberty.h
  declares it. The calls, such as gcov's, reach musl's POSIX `basename`, as
  in an upstream musl build.

GCC 13 already rejects split stacks for musl, and `tm.h` also removes the
thread control block offset so that `-mglibc` cannot enable them. Tests
check that `cc1` accepts `-mglibc` and still rejects `-fsplit-stack` with it.

The compilers link libbacktrace and libcody, so the package provides
libbacktrace's BSD notice, which a test checks against its source header,
and libcody's license. See [patches](patches/README.md) for the release's own
source changes.

```
buck2 test cellar//bootstrap/stage1/gcc13: cellar//bootstrap/stage1/libstdcxx13:
buck2 test cellar//bootstrap/stage1/gcc13:stage-comparison cellar//bootstrap/stage1/libstdcxx13:stage-comparison
```
