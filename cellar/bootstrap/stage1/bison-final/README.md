<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Final Bison 3.4.1

The static final Bison is compiled with stage3 GCC 4.7.4 and musl 1.2.5. BUILD
owns the native configuration, source inventory, separate gnulib archive,
scanner generators, parser generation and installation. The earlier Bison
package supplies the pinned source and completes the handwritten, simplified
and upstream grammar passes; no release-generated parser becomes an input.

Final Flex regenerates all three scanners. The predecessor Bison generates the
upstream grammar parser and the final executable reproduces both parser C and
header bytes. The native C99 configuration uses musl's noreturn definitions and
POSIX text/binary equivalence. Logical source paths remain stable. Final m4,
Bash and the complete skeleton directory are explicit RunInfo dependencies.

Eighteen tests cover parser regeneration, precedence, 64-bit values, syntax
errors, GLR alternatives and cleanup/destructors, missing m4 and a generated
C++ parser compiled and run with final G++/libstdc++. All compilation uses
`-Werror`. The installation includes bison, the full skeleton/m4 data inventory
and the upstream license. The assembled userland supplies the relocatable
runtime environment and yacc compatibility entry point.

```
buck2 test cellar//bootstrap/stage1/bison-final: --local-only -j 8
```
