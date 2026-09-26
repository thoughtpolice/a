<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# musl 1.2.5

The first GCC 4.0.4 builds static musl 1.2.5 for native x86_64: the normal
libc and complex sources, mallocng, POSIX threads, the CRT objects and the
empty compatibility archives such as `libm.a`. Binutils 2.30 assembles the
native assembly sources. The archive's SHA256 is the one live-bootstrap pins.
No configure or Make process runs.

The configuration follows upstream's static native recipe, limited to options
GCC 4.0.4 supports. GCC 4.0 needs `-fms-extensions` to accept the anonymous
union in the public ptrace structure, and a test checks that structure's
native layout. The x86_64 FMA dispatch sources include their generic C
versions, which BUILD lists as inputs too.

## Tables

musl-chartable-tools, at the revision BUILD pins, regenerates the five
character and case-mapping tables from Unicode 12.1 data, including the Hangul
combining-character correction. The eight iconv tables come from
[musl-tables](../musl-tables/README.md). All thirteen match the release, whose
copies are test fixtures and never library inputs. The case-mapping comparison
is byte for byte; the others compare table values.

## Compilers and runtimes

`:header-compiler` compiles musl against only its new headers. `:runtime`
pairs the new libc and headers with the first GCC 4.0.4's libgcc, libgcov,
`crtbeginT.o` and `crtend.o`, and `:gcc` runs that GCC against it; the
compiler itself still runs on musl 1.1.24. `:gcc-link-runtime` is what `:gcc`
links around a program.

## Tests

The tests cover table regeneration, headers, varargs and struct layout,
startup, the environment, syscalls, processes, setjmp, the floating-point
environment, native math, Unicode and iconv, and allocation, alignment and
reallocation stress. Thread tests cover TLS, errno, mutexes, condition
variables, rwlocks, once, robust mutexes, semaphores, cancellation and
cleanup handlers. Complex tests cover the float, double and long double
calling conventions and mathematical identities. musl 1.2.5 computes some long
double complex functions, cexpl and csqrtl among them, in double precision,
and the tests do not expect more.

```
buck2 test cellar//bootstrap/stage1/musl12:
```
