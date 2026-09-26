<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# zlib 1.3.2

The final GCC 13.5 stage and musl 1.2.5 build zlib's static library from
its release tarball, as its configure script and Makefile would for Linux.
[CPython](../python/README.md) links it for its `zlib` module and for
`binascii`'s CRC-32, and reads the Unicode database's Unihan archives through
it.

configure writes `zconf.h` from `zconf.h.in`, recording that `unistd.h` and
`stdarg.h` exist, and gives GCC `-O3 -fPIC`, `-D_LARGEFILE64_SOURCE=1`,
since musl declares `off64_t` with it, and `-DHAVE_HIDDEN`, since GCC can
hide the symbols zlib's sources share. The build compiles the Makefile's
fifteen sources from a tree holding that `zconf.h` in place of the shipped
template. `:installation` holds `libz.a`, `zlib.h`, `zconf.h` and the
license, and `:headers` the two headers alone.

## Tests

As `make test` does, the package builds zlib's `example` and `minigzip`
twice, as they are and with a 64-bit `off_t`, which musl always has.
`minigzip-test` and `minigzip64-test` compress and decompress a line through
each `minigzip`, and `example-test` and `example64-test` run each `example`,
which exercises the library's interfaces and fails on any mismatch.

```
buck2 test cellar//bootstrap/stage1/zlib:
```
