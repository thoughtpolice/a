<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

Bzip2 1.0.8 and bzip2recover are static final-GCC/musl programs. BUILD
declares the library, programs and public C interface. The generated CRC
table is excluded from source inputs and regenerated from its polynomial
by a native C generator. randtable.c is the fixed format table required to
decode historical randomized bzip2 blocks.

The six upstream compression/decompression vectors and block-recovery
test validate the programs. Expected compressed bytes are test fixtures
only. The installation includes libbz2.a, bzlib.h and the bunzip2/bzcat
invocation aliases. No configure or Make action is used.

The recovery utility uses the ISO C `%llu` format instead of glibc's `%Lu`
extension; the block-recovery test exercises that musl compatibility change.
