<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# bzip2 1.0.8

GCC 4.7.4 stage3 and musl 1.2.5 build libbz2, bzip2 and bzip2recover as
static programs. A native C generator regenerates the CRC table from its
polynomial, so the release table is not an input. randtable.c stays, since
decoding old randomized bzip2 blocks needs its fixed table.
`:installation` holds bzip2 with its bunzip2 and bzcat names, bzip2recover,
libbz2.a and bzlib.h.

bzip2recover prints block offsets with the ISO C `%llu` format instead of
glibc's `%Lu`, which musl does not support.

## Tests

bzip2 compresses and decompresses the three upstream sample files, and the
results must match the samples byte for byte. bzip2recover splits a sample
into blocks, and bzip2 must decompress the first block to the original.

```
buck2 test cellar//bootstrap/stage1/bzip2:
```
