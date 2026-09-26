<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GMP 6.2.1

The rebuilt GCC 4.0.4 and musl 1.2.5 build GMP's static library for native
LP64 x86_64 with generic C code. BUILD declares the library, six upstream
generators and the tables they write, the public header substitutions, the
configuration and `:installation`. Each generator uses upstream's mini-GMP
bootstrap implementation. The archive hash matches live-bootstrap's. No
configure, Make, assembly implementation or release-generated file enters the
build.

The library uses 64-bit limbs without nails, generic C with no inline
assembly, upstream's generic tuning thresholds, FFT support and reentrant
heap allocation for temporaries. Archive order and member names are explicit.
The GMP C++ wrapper is not built, since the compiler has no C++.

## Tests

The selected upstream tests run with random seed 42. They cover integer,
rational and floating-point arithmetic, conversions, roots, powers, primes,
factorials, Fibonacci numbers, division, GCD, limb operations, Toom
multiplication, random states and formatted I/O. The two formatted-I/O tests
run in declared output directories, and their captured output is compared.
File I/O tests, assembly instrumentation, locale-dependent tests and the
generated random-test source are left out.

```
buck2 test cellar//bootstrap/stage1/gmp:
```
