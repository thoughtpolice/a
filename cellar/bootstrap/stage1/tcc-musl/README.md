<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# TCC 0.9.27 with musl

Release TCC 0.9.27 moves from Mes libc to musl 1.1.24 in three builds, each
compiled by the one before it. Each build also compiles its own `libtcc1.a`.

| Compiler | Compiled by | Linked against | Its toolchain's libc |
| --- | --- | --- | --- |
| `tcc-musl0` | `tcc:tcc-boot2` | `musl:initial` | `musl:initial` |
| `tcc-musl1` | `tcc-musl0` | `musl:initial` | `musl:initial` |
| `tcc-musl2` | `tcc-musl1` | `musl:rebuilt` | `musl:rebuilt` |

`tcc-musl1` compiles `musl:rebuilt`, and `tcc-musl2` compiles `musl:restored`
and the `musl-tables` generators. The toolchain `musl<N>` pairs `tcc-musl<N>`
with the `runtime-musl<N>` sysroot: its libc's CRT objects and libraries plus
the new `libtcc1.a`. `musl<N>-link-runtime` holds the same files for linking
other programs. `defs.bzl` describes one build.

Each compiler's tests build and run musl's header, runtime, thread, fenv and
syscall programs, and let the driver alone find the CRT objects and libraries
in the sysroot.

```
buck2 test cellar//bootstrap/stage1/tcc-musl: --local-only -j 8
```
