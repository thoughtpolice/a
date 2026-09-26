<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU Bison 3.4.1

GCC 4.7.4 stage3 and musl 1.2.5 build a static Bison from the source that
the [early Bison](../bison/README.md) prepared. The early package also runs
the handwritten, simplified and upstream grammar passes, so no
release-generated parser is an input here. BUILD declares the native
configuration and a gnulib archive with gnulib's application helpers, bitsets
and formatting code, while musl supplies the POSIX functions. `:installation`
holds bison with its skeleton and m4 data.

The final Flex regenerates the three scanners, and the early Bison generates
the upstream grammar parser. The runnable `:bison` target gets the final m4,
Bash and the skeleton directory through its environment. Every source
compiles under a stable logical path with `-Werror`.

## Tests

The final Bison regenerates its own grammar parser, and the C and header
bytes must match the early Bison's output. Generated parsers are compiled and
run for precedence, 64-bit values, syntax errors, GLR alternatives and
destructor cleanup, and a C++ parser is compiled and run with the GCC 4.7.4
G++ and libstdc++. Bison must fail when m4 is missing.

```
buck2 test cellar//bootstrap/stage1/bison-final:
```
