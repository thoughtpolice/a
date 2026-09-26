<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# TCC 0.9.27 with GNU binutils

Once binutils 2.30 exists, TCC archives and links with GNU ar and ld, and GNU
as assembles musl's native sources. This package fixes TCC's hexadecimal float
reader and builds the last TCC, which runs against the GNU-assembled musl.

| Compiler | Compiled by | Linked against |
| --- | --- | --- |
| `tcc-hexfloat` | `tcc-musl:tcc-musl2`, with GNU ar and ld | `musl:restored` and an x87 `scalbnl` |
| `tcc-gnu` | `tcc-hexfloat`, with GNU ar and ld | `musl:gnu` |

TCC's hexadecimal float reader rounded through `double`, which corrupted the
`long double` constants that musl uses. The two patches convert hexadecimal
constants with musl's `strtof`, `strtod` and `strtold` instead.
`tcc-hexfloat` compiles `musl:gnu`. Until then only the restored musl exists,
whose `scalbnl` has corrupted constants, so `tcc-hexfloat` links `scalbnl.s`
instead.

`tcc-gnu` compiles its own `libtcc1.a`, with GNU as assembling `alloca`. `:tcc`
pairs `tcc-gnu` with the `runtime` sysroot: the gnu musl and that `libtcc1.a`.
`:link-runtime` holds the same files for linking programs.

`gnu-toolchain-link` first runs a program that TCC compiled, GNU as assembled,
GNU ar archived and GNU ld linked. The tests of both compilers check exact
floating representations, extreme exponents and fused operations, then startup,
threads and TLS, syscalls and Unicode. The `tcc-gnu` tests also check the
native math. Its driver must link a program by itself against the GNU-created
archives, and fail when the sysroot lacks headers or libraries.

```
buck2 test cellar//bootstrap/stage1/tcc-native: --local-only -j 8
```
