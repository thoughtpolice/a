<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# zlib 1.3.2

The final GCC 13.5 stage and musl 1.2.5 build zlib's static library from
its release tarball, as its configure script and Makefile would for Linux.

configure writes `zconf.h` from `zconf.h.in`, recording that `unistd.h` and
`stdarg.h` exist. It gives GCC `-O3 -fPIC`, `-D_LARGEFILE64_SOURCE=1`,
since musl declares `off64_t` with it, and `-DHAVE_HIDDEN`, since GCC can
hide the symbols zlib's sources share. The build compiles the Makefile's
library sources from a tree holding that `zconf.h` in place of the shipped
template. `:installation` holds `libz.a`, `zlib.h`, `zconf.h` and the
license, and `:headers` the two headers alone.

## Tests

The tests are the checks of `make teststatic`. `minigzip-test` compresses a
line with zlib's `minigzip` and decompresses it again, and `example-test`
runs `example`, which exercises the library's interfaces and fails on any
mismatch.

```
buck2 test cellar//bootstrap/stage1/zlib:
```
