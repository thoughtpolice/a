<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# TCC 0.9.27 with Mes libc

The TCC 0.9.26 fixed point compiles release TCC 0.9.27 twice, as the pinned
live-bootstrap recipe does. Both compilers link statically against Mes libc.

| Compiler | Compiled by | Linked against | Toolchain and its sysroot |
| --- | --- | --- | --- |
| `tcc-mes0` | `tcc:tcc` | `tcc:runtime-boot2` | `mes0-compiler`, `tcc:runtime-boot2` |
| `tcc-mes1` | `tcc:tcc-boot2` | `runtime-mes0` | `mes1-compiler`, `runtime-mes1` |

`tcc-mes0` rebuilds the Mes runtime as `runtime-mes0`: Mes libc, the CRT
objects, getopt and the release's `libtcc1.a`. `runtime-mes1` pairs that libc
with a `libtcc1.a` that 0.9.26 compiles from the release sources. All builds
use separate translation units and the configuration in `defs.bzl`.

The archive-open, weak-symbol index, static-default, C99 array qualifier and
null GOT relocation fixes follow live-bootstrap revision
`dd8ac27bf959344b9bcf5e876bdd7716879bbc70`. Local patches link static x86_64
calls without a PLT, fill GOT entries before section tidying removes their
relocations, and make the static driver search libc again after `libtcc1.a`,
whose varargs helpers call `abort`. They also allow archives without members,
add the `ldmxcsr` and `stmxcsr` instructions, and widen Mes libc's `abtol`
accumulator to 64 bits. Each patch's `.license` file records its origin.

The tests compile and run the acceptance programs with both compilers, and
link the `tcc-mes0` objects again against `runtime-mes0`. The programs cover
the native ABI, integer and floating arithmetic, mixed varargs, separate
compilation and archives, weak symbols, including a weak-only archive member,
and C99 array parameters. Both compilers must reject invalid C, and
`mes1-compiler` must link an empty archive and a program using both MXCSR
instructions.

```
buck2 test cellar//bootstrap/stage1/tcc-release: --local-only -j 8
```
