<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# MPFR 4.1.0

The rebuilt GCC 4.0.4 builds MPFR's static library in GNU C99 mode against
[GMP](../gmp/README.md) and musl 1.2.5. BUILD declares the library's
translation units, fixed generic tuning parameters, the upstream
`get_patches.sh` source generator, which runs with the bootstrapped Bash and
cat, and `:installation`. The archive hash matches live-bootstrap's. No
configure or Make process runs.

`MPFR_GENERIC_ABI` selects the handwritten generic arithmetic. The optional
F*-extracted C and the architecture lookup tables stay out of the source
tree, and inline assembly is off. The configuration uses IEEE float and
double, x87 extended long double, GNU TLS with per-thread caches, GMP 6.2.1
and musl 1.2.5. GCC 4.0.4 has no decimal or float128 types. One deliberate
integer-range check in `vasprintf.c` keeps its old-GCC warning without making
it fatal.

## Tests

The selected upstream tests run with seed 42 and cover arithmetic, rounding,
special functions, constants, conversions, subnormals, formatting, allocation
and exception flags. They read their data files through a declared directory.
An extra pthread test checks that each thread keeps its own precision,
rounding mode and flags, that constant caches work concurrently, and that
caches are freed. Optional type tests, stack-interface tests and tests that
write files are left out.

```
buck2 test cellar//bootstrap/stage1/mpfr:
```
