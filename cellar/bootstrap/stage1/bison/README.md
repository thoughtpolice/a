<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Bison 3.4.1

The first pass uses Giovanni Mascellani's handwritten parser and header from
live-bootstrap dd8ac27bf959344b9bcf5e876bdd7716879bbc70. Their source notices and
GPL-3.0-or-later license are preserved. This parser implements only the subset
needed to bootstrap the simplified grammar; it is not the delivered Bison.

Flex 2.6.4 regenerates all three scanners. Upstream scanner wrapper translation
units provide config.h and system.h before the generated scanner. The native
configuration uses musl's allocation, POSIX, math, spawn and stream-error
functions, with gnulib's application helpers, bitsets and formatting support.
The two obstack printf declarations normally supplied by gnulib's stdio wrapper
are explicit in native-declarations.h. All C compilation uses -Werror.

RunInfo carries the declared m4, its Bash dependency, and the complete upstream
skeleton/m4sugar directory. Default paths do not point to a host installation.
The m4-path adaptation is copyright 2026 Austin Seipp, GPL-3.0-or-later, and preserves
the upstream output.c source notices in its generated result.

Each of the three passes builds `bison-<pass>` around a different parser, as
`defs.bzl` describes, and checks it with version and calculator tests:
precedence, parentheses, 64-bit semantic values and syntax errors. The
calculator grammar uses named tokens because the handwritten parser does not
accept character literals.

- The seed pass compiles the handwritten parser.
- The simple pass compiles the parser that the seed generates from the
  reference's simplified parse-gram.y. This grammar accepts upstream Bison
  syntax but omits its own %printer and %destructor actions, as the bootstrap
  sequence requires.
- The full pass compiles the parser that the simple pass generates from the
  unmodified upstream grammar, and becomes the runnable `:bison`.

Regenerating the upstream grammar once more with `:bison` produces identical
parser C and header files. Further tests cover GLR resolution of
reduce/reduce conflicts and semantic %printer and %destructor behavior on
valid and invalid input. The C++ skeletons ship in the data directory.

```
buck2 test cellar//bootstrap/stage1/bison: --local-only -j 8
```
