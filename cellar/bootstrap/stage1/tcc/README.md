<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# TCC 0.9.26 fixed point

This package builds the bootstrappable TCC 0.9.26 fork
(`tcc-0.9.26-1147-gee75a10c`) from MesCC and then with itself until two
generations produce the same bytes. Every generation links statically against
Mes libc.

| Compiler | Compiled by | Linked against |
| --- | --- | --- |
| `tcc-seed` | MesCC, as one translation unit | Mes libc from `mes` |
| `tcc-boot0` | `tcc-seed` | `runtime-initial` |
| `tcc-boot1` | `tcc-boot0` | `runtime-boot0` |
| `tcc-boot2` | `tcc-boot1` | `runtime-boot1` |

Each `runtime-<stage>` sysroot holds Mes libc, compiled one source at a time,
the CRT objects, getopt and TCC's support library `libtcc1.a`. `tcc-seed`
compiles `runtime-initial`, and `tcc-bootN` compiles `runtime-bootN`. The boot
compilers compile TCC's sources separately with identical configuration, so
`tcc-boot1` and `tcc-boot2` must match: the `:fixed-point` suite compares their
`tcc`, `libtcc.a`, CRT objects, `libc.a`, `libgetopt.a` and `libtcc1.a`.
`:tcc` is `tcc-boot2` with the `runtime-boot2` sysroot.

The seed cannot evaluate floating-point constants, so patches build those
values at run time in Mes libc's `abtod`, in TCC's support library and in the
compiler's negative zero. Other patches delay opening the archive until option
parsing finishes, as the pinned live-bootstrap recipe does, and let MesCC
compile TCC's archive header and aggregate assignments. TCC links static
calls directly, the Mes headers gain x86_64 `stdarg.h` and `setjmp.h`, and Mes
libc's buffered `read` passes descriptors beyond its cache to the kernel.

The tests run programs built against each runtime. They cover startup
arguments and environment, stack alignment, syscalls and errno, setjmp and
longjmp, integer and floating arithmetic, mixed varargs, archives and weak
symbols. The later compilers must also reject invalid C and fail when the
sysroot lacks headers or libraries.

```
buck2 test cellar//bootstrap/stage1/tcc: --local-only -j 8
```
