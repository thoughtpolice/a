<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native musl bootstrap

The `runtime-initial` sysroot is static musl 1.1.24, compiled by Mes-linked
TCC 0.9.27. BUILD declares every source, native override, header generator,
object, archive and CRT. Each object has a short unique archive member name.
Libc compiles with warnings treated as errors.

The initial and corrective rebuilt runtimes exclude complex functions and
consumers of generated Unicode/ctype/iconv tables. Those shipped tables are
absent from their prepared source directories. `runtime-restored` restores all
Unicode/ctype/iconv functions using the twelve source-regenerated tables from
`musl-tables`; it still excludes complex functions. Generic C math implementations are selected while the early
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
buck2 build cellar//bootstrap/stage1/musl:runtime-restored
buck2 run cellar//bootstrap/stage1/musl:tcc -- example.c -o example
```

The fifteen acceptance tests cover generated layouts and varargs, startup and
environment, formatted output, allocation/reallocation, mmap, setjmp, floating
arithmetic, fork/pipe/wait, fenv, signal-mask restoration, file-backed mmap with
a nonzero offset, and concurrent threads with independent errno and a mutex.
The restored runtime also exercises Unicode classification, case, widths,
multibyte decoding, UTF-16/single-byte/Japanese conversion round trips, Chinese
and Korean decoding, and malformed/truncated/output-limited iconv input.
The tests use Linux memfd for their temporary file and need no host userland.

The static TCC driver rescans libc after adding libtcc1, since its native
varargs helpers introduce an `abort` reference. Driver-level regressions cover
ordinary compilation and automatic runtime selection in all three musl-linked
TCC stages.

The runnable compiler marks musl headers as system headers. Package include
directories take precedence, with a compile/run regression for that ordering.
