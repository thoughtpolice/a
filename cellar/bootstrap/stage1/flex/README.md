<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Flex 2.6.4

Oyacc regenerates the grammar parser, and upstream mkskel.sh runs with bootstrap
Bash, sed and m4. Flex 2.5.11 generates the initial scanner; that Flex 2.6.4
executable regenerates the scanner again. The completed executable reproduces
that scanner byte-for-byte with line directives disabled. Release-generated
parse.c, parse.h, scan.c and skel.c are excluded from consumed source inputs.

The runnable `:flex` carries its m4 executable and m4's Bash dependency in
RunInfo. The source adaptation replaces m4's PATH fallback with a required M4
setting; a raw executable without it fails. Its exact replacement blocks are
derived from the BSD-licensed main.c (see the pinned source COPYING), with the
adaptation copyright 2026 Austin Seipp under BSD-2-Clause.

Ten tests cover version, scanner regeneration, compressed/full/fast tables,
eight-bit input and exclusive states, reentrant scanners, libfl support,
diagnostics, missing m4, and separate compilation against a generated header
with external table loading. All C compilation uses -Werror.

```
buck2 test cellar//bootstrap/stage1/flex: --local-only -j 8
```
