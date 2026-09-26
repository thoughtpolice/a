<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GCC ports from 10.5 on

`defs.bzl` describes how one GCC release from 10.5 on bootstraps through
three stages, and `libstdcxx.bzl` how each stage builds that release's
libstdc++. A release's package calls `gcc_port` with what differs: the
archive, the compiler and C++ library that build its first stage, binutils,
file lists in `sources.bzl`, the reviewed configure answers in `config.bzl`,
and the tables, support libraries and tests only that release has. Its C++
library package calls `libstdcxx_port` the same way. No configure or Make
process runs.

This package also holds what the ports share beside the macros:
`generators/gperf.awk`, the compiler and support-library test programs in
`tests/`, and the libstdc++ test programs in `tests/libstdcxx/`.

## Sources

The bootstrapped [pax extractor](../pax/README.md) unpacks the release
straight from `unxz`, since GCC archives store long member names in pax
records. It extracts only the directories the compilers and libstdc++ read.
Small support directories are projected whole. The gcc, libcpp and
libdecnumber trees use manifests from `sources.bzl` that withhold every file
the port regenerates.

## Regenerated sources

Shipped generated files are comparison fixtures, never compiler inputs. Each
stage builds the generators with its own host compiler and must reproduce
every fixture.

- `libcpp/ucnid.h` comes from GCC's `makeucnid`, with a bounds fix that stops
  its final flush from reading past the tables. A release can add further
  libcpp tables and their generators.
- `libcpp/generated_cpp_wcwidth.h` comes from a Python script over glibc's
  `utf8_gen.py` upstream. Each release's `generators/wcwidth.c` reimplements
  both in C and reads the Unicode data GCC ships.
- The CRC table in `libiberty/crc32.c` comes from the generator in its own
  comment.
- The DPD and BID decimal tables come from the GCC 4.7 port's generators.
  The tests compare every value, so updated notices do not matter.
- gengtype's scanner comes from the bootstrapped Flex 2.6.4, which also wrote
  the shipped copy. The two differ only in the release manager's absolute
  path in `#line` directives, which the comparison removes.
- `cp/cfns.h` is gperf output upstream. `generators/gperf.awk` writes an
  equivalent sorted table and bisecting lookup with the bootstrapped awk. A
  test checks that the table holds the same names as gperf's lookup, agrees
  with it for each, and rejects the same near misses. A release can add
  further gperf tables.

Option records, pass instances and the x86 builtin types come from GCC's awk
scripts, the machine description from GCC's generators in five layers, and
the garbage collector roots from gengtype.

## Configuration

`tm.h`, `tm_p.h`, `config.h`, `bconfig.h` and `tconfig.h` are written as
`gcc/mkconfig.sh` would write them from config.gcc's lists for x86_64 musl.
`auto-host.h` holds the release's reviewed `gcc/config.in` values from
`config.bzl`, with the target-visible macros outside `USED_FOR_TARGET`, as
config.in has them. Release checking keeps assertions enabled and extra
checks off. The support libraries share `library-config.h`, and libgcc
gets its own `auto-target.h` and `libgcc_tm.h`.

Some choices differ from what configure would write:

- Only the C, C++ and LTO option files and the C and C++ tree codes and
  garbage collector roots are included. configure collects every front end
  present in the source tree.
- `multilib.h` describes one native x86_64 library directory, as in the GCC
  4.7 port. The driver's specs accept only static native executables and
  reject `-m32`, `-shared`, `-pie` and `-static-pie`.
- `ld` is never passed `--sysroot`, and the 32-bit-only assembler probes are
  off, as a real configure against x86_64-only binutils would find.

## Compilers and runtime

Each stage builds its own support libraries, generators and compilers from
the same sources. The host release's final stage and C++ library build the
first stage; each later stage uses its predecessor's compiler and libstdc++.
As upstream, each stage keeps its compiler's default C++ dialect, and later
stages add `-Werror`. The compilers link GMP, MPFR, MPC, binutils' zlib and
libbacktrace, and the static analyzer is enabled, as upstream. A release can
link further objects into `cc1` and `cc1plus`; each stage's host compiler
builds that stage's copy.

The new driver builds libgcc, libgcov and the startup objects with upstream's
flags for x86_64 Linux, and the compiler's include directory has libgcc's
`unwind.h` and `gcov.h`. As upstream, the driver links `crtfastmath.o` for
`-Ofast` and `-ffast-math` and `crtprec32.o` to `crtprec80.o` for `-mpc32` to
`-mpc80`.

## Source changes

The port applies these exact replacements with the bootstrapped immutable
patch helper. Each must match exactly one block of the pinned source; no
fuzzy patching runs. Their before blocks keep GCC's GPL-3.0-or-later license,
with the GCC Runtime Library Exception for libgcc. The replacements are
Copyright 2026 Austin Seipp under the same terms.

- `makeucnid` stops before reading the entry one past its code-point tables
  in the final flush. The generated `ucnid.h` is unchanged.
- `genmatch` names its include directory `.` instead of the absolute working
  directory, which it would otherwise write into the comments of the
  generated match sources.
- The driver makes a compiler, assembler or linker that it cannot find beside
  itself an error for ordinary commands and pipeline members, rather than a
  program to search for on the host `PATH`.
- `linux-unwind.h` enables the x86_64 signal-frame unwinder for musl as well
  as glibc. GCC gates it on `__GLIBC__`, and musl's `__restore_rt` is the same
  `rt_sigreturn` sequence the unwinder recognizes.

Each release supplies its own `tmpdir.patch`, since libiberty's
`make-temp-file.c` differs between releases. It makes a missing `TMPDIR`
fatal in the temporary directory selection, instead of a fallback to a host
directory.

## Tests and stage comparison

Each stage's compiler, driver and runtime pass the same execution tests: C
and C++ front-end diagnostics, missing headers, tools and libraries,
preprocessing, the rejected link modes, `-nolibc`, and runtime programs at
`-O0` and `-O2`. The runtime programs cover 128-bit and complex arithmetic,
signal-frame unwinding, extended precision, startup, threads, `-pthread`,
math, Unicode, and the floating-point modes the `-ffast-math` and `-mpc32`
startup files set. A coverage test compiles, runs and reports an
instrumented program with each stage's gcov, and another calls libgcov
through `gcov.h`. The support libraries have their own tests for demangling,
temporary files, preprocessing and decimal arithmetic.

Stage2 and stage3 compare byte for byte: every host object of the support
libraries, generators, compilers, drivers and zlib, every libgcc and libgcov
object, the startup objects and archives, and every libstdc++ object and
archive. Only `cc1-checksum.o` and `cc1plus-checksum.o` are excluded, since
each encodes its own stage's link inputs. `audit-gcc-comparison.py` checks
the comparison inventory as in the [GCC 4.7 port](../gcc47/README.md), for
example:

```
buck2 uquery 'kind("c_object", set(cellar//bootstrap/stage1/gcc10: cellar//bootstrap/stage1/libstdcxx10:))' --json > /tmp/gcc-objects.json
buck2 uquery 'kind("command_test", set(cellar//bootstrap/stage1/gcc10: cellar//bootstrap/stage1/libstdcxx10:))' --output-attribute=args --json > /tmp/gcc-tests.json
python3 cellar/bootstrap/audit-gcc-comparison.py --objects /tmp/gcc-objects.json --tests /tmp/gcc-tests.json
```

## libstdc++

`libstdcxx_port` compiles the release's translation units with the
per-directory and per-file Makefile.am flags from its `sources.bzl`, and
archives them as an upstream `--disable-shared` build does. Upstream's sed
pipeline writes `bits/c++config.h` from the reviewed `config.h` and the
gthread headers. `cxx11-ios_failure` is compiled to assembly, has its
type_info repointed at the old-ABI failure vtable, and is then assembled, as
upstream does, so that old-ABI handlers still catch iostream failures. Each
stage's `g++` builds and runs the test programs in `tests/libstdcxx/` at
`-O0` and `-O2`, and stage2 and stage3 compare every object and archive.
