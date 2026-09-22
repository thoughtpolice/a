<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native static MPFR 4.1.0

BUILD declares 240 library translation units, fixed generic tuning parameters,
the upstream `get_patches.sh` source generator, and explicit installation files.
The generator runs with bootstrapped Bash and GNU cat. The archive hash matches
the pinned live-bootstrap revision. No configure or Make process runs.

`MPFR_GENERIC_ABI` selects handwritten generic arithmetic; optional F*-extracted
C and architecture lookup tables are excluded from the consumed source tree.
Inline assembly is disabled. The configuration uses native IEEE float/double,
x87 extended long double, GNU TLS with per-thread caches, GMP 6.2.1 and musl
1.2.5. GCC 4.0.4 builds the library in GNU C99 mode. Decimal and float128 types
are unavailable at this stage. One intentional integer-range check in
`vasprintf.c` retains its old-GCC warning without making that warning fatal.

All 174 selected upstream tests and an additional pthread/TLS test pass. The
upstream tests exercise arithmetic, rounding, special functions, constants,
conversions, subnormals, formatting, allocation, and exception flags with seed
42. The pthread test checks independent precision, rounding and flags, concurrent
constant caches, and cache cleanup. Tests receive declared data fixtures through
an explicit environment variable. Optional type tests, stack-interface tests,
and tests that write output files are excluded from this gate.

```
buck2 test cellar//bootstrap/stage1/mpfr: --local-only -j 8
buck2 build cellar//bootstrap/stage1/mpfr:installation
```
