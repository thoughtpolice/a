<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native musl bootstrap

The `runtime-initial` sysroot is static musl 1.1.24, compiled by Mes-linked
TCC 0.9.27. BUILD declares every source, native override, header generator,
object, archive and CRT. Each object has a short unique archive member name.
Libc compiles with warnings treated as errors.

This first runtime excludes complex functions and consumers of generated
Unicode/ctype/iconv tables. Those shipped tables are absent from its prepared
source directory. Generic C math implementations are selected while the early
assembler lacks the complete native math instruction set. Native TLS, clone,
setjmp, string and floating-environment assembly remain enabled.

The small patches adapt SysV varargs to TCC's runtime helpers, use a conventional
assembly entry for Linux syscalls that exceed TCC's inline-assembly register
allocator, remove PLT syntax from static sigsetjmp calls, and preserve errno
across malloc's madvise optimization. They do not import the reference's i386
or Fiwix thread-pointer/clone workarounds. The madvise change follows the pinned
live-bootstrap patch by Richard Masters (MIT). Musl's upstream COPYRIGHT is
preserved in the archive projection; the other local adaptations are MIT.

```
buck2 test cellar//bootstrap/stage1/musl: --local-only -j 8
buck2 build cellar//bootstrap/stage1/musl:runtime-initial
```

The five acceptance tests cover generated layouts and varargs, startup and
environment, formatted output, allocation/reallocation, mmap, setjmp, floating
arithmetic, fork/pipe/wait, fenv, signal-mask restoration, file-backed mmap with
a nonzero offset, and concurrent threads with independent errno and a mutex.
The tests use Linux memfd for their temporary file and need no host userland.
