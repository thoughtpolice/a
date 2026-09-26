<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Flex 2.6.4

GCC 4.7.4 stage3 and musl 1.2.5 build a static Flex and libfl from the source
and m4 patch of the [early Flex](../flex/README.md). Oyacc regenerates the
grammar parser, and upstream mkskel.sh runs with the final Bash, sed and m4.
The early Flex generates the first scanner, and the Flex built from it
generates the scanner of the delivered Flex. No release-generated scanner,
parser or skeleton is an input. Every source compiles under a stable logical
path with `-Werror`. `:installation` holds flex, libfl.a, FlexLexer.h and
the license.

## Tests

The delivered Flex must reproduce its own scanner byte for byte. Generated
scanners are compiled and run for compressed, full and fast tables, eight-bit
input, exclusive states, reentrancy, libfl, external tables and generated
headers, and a C++ scanner is compiled and run with the GCC 4.7.4 G++ and
libstdc++. Flex must reject a malformed grammar and fail when m4 is missing.

```
buck2 test cellar//bootstrap/stage1/flex-final:
```
