<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native static musl 1.2.5

The source archive uses the SHA256 pinned by live-bootstrap at
`dd8ac27bf959344b9bcf5e876bdd7716879bbc70`. BUILD selects the native x86_64
architecture overrides, all normal libc and complex sources, mallocng, and
POSIX threads. Each C source is compiled by the first GCC 4.0.4; native assembly
uses the bootstrapped binutils 2.30 assembler. CRT objects and compatibility
archives are explicit targets. No configure or Make process builds this package.

The five character/case tables are regenerated with upstream chartable-tools
`78b213a868553b1154ee9627c96ff1f14a9a3b1b`, including Unicode 12.1 data and the
Hangul combining-character correction. The unchanged eight iconv tables reuse
the earlier validated generator outputs. All thirteen tables match this release;
the release copies are test fixtures, never library inputs. The case-mapping
comparison is byte-for-byte; other comparisons check table values.

Configuration follows the static native upstream recipe using options supported
by GCC 4.0.4. This older compiler requires `-fms-extensions` to accept the anonymous
union in the public ptrace information structure. A test verifies its 88-byte
native layout and member offsets. The x86_64 FMA dispatch sources include their
generic C implementations; those are explicit source inputs as well.

`musl12:runtime` pairs the new libc and headers with the first GCC's support
archives and CRT bookends. `musl12:gcc` executes that existing compiler against
this output sysroot. The compiler still executes with its predecessor libc until
the next GCC rebuild. `musl12:installation` contains musl's headers, libraries,
CRT objects, and copyright notice.

All 24 tests pass: table regeneration, header/varargs/layout checks, startup,
environment, syscalls, processes, setjmp, floating-point environment and native
math, Unicode/iconv, allocator/alignment/reallocation stress, and POSIX threads.
Thread tests cover TLS, errno, mutexes, condition variables, rwlocks, once,
robust-owner recovery, semaphores, cancellation and cleanup handlers. Complex
tests cover float/double/long-double calling conventions and mathematical
identities. Upstream 1.2.5 implements some long-double complex functions, including
cexpl and csqrtl, through their double-precision counterparts; this build retains
that limitation. The tests do not claim greater precision.

```
buck2 test cellar//bootstrap/stage1/musl12: --local-only -j 8
buck2 build cellar//bootstrap/stage1/musl12:installation
```
