<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GMP 6.2.1, generic C

The archive hash matches the pinned live-bootstrap revision. BUILD declares the
static native LP64 library, six upstream generators and their eight generated
tables, public header substitutions, reviewed configuration, and installation.
Each generator uses upstream's handwritten mini-GMP bootstrap implementation.
No configure, Make, assembly implementation, release-generated parser, or host
compiler enters the build graph.

The library uses 64-bit limbs without nails, generic C implementations, no inline
assembly, upstream generic tuning thresholds, FFT support, and reentrant heap
temporary allocation. The rebuilt GCC 4.0.4 and full musl 1.2.5 build and execute
all tools. Archive order and short member names are explicit.

All 164 selected upstream tests pass with random seed 42. These cover integer,
rational and floating-point arithmetic, conversions, roots, powers, primes,
factorials, Fibonacci numbers, division, GCD, limb operations, Toom algorithms,
random states, and formatted I/O. The two formatted-I/O tests execute inside
declared output directories and their captured output is compared. Other file
I/O tests, assembly instrumentation, locale-dependent tests, and the generated
random-test source are not included in this gate. The GMP C++ wrapper is not
built at this predecessor-C-only stage.

```
buck2 test cellar//bootstrap/stage1/gmp: --local-only -j 8
buck2 build cellar//bootstrap/stage1/gmp:installation
```
