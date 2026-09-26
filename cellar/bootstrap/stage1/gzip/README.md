<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU gzip 1.2.4

GCC 4.7.4 stage3 and musl 1.2.5 build a static gzip with the generic C
compressor and decompressor, file timestamps, permissions and recursion. The
stage0 decoder and the early tar extract the release. Upstream's makecrc
regenerates the CRC table, and the release table is stripped from util.c
before compilation. [patches/README.md](patches/README.md) describes the
getopt fix. `:installation` holds gzip with its gunzip and zcat names.

## Tests

A C test drives gzip through deterministic compression, binary round trips,
CRC error detection, in-place compression, and timestamp and mode
preservation.

```
buck2 test cellar//bootstrap/stage1/gzip:
```
