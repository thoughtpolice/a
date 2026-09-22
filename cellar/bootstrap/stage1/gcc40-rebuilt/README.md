<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GCC 4.0.4 rebuilt with full musl

This stage rebuilds every compiler generator, library, compiler object, and
driver using the first GCC 4.0.4 with the full musl 1.2.5 sysroot. The BUILD file
declares the complete graph; shared source inventories and handwritten patches
are exported by the preceding GCC package. No configure or Make process runs.

The predecessor now supports GCC's compile-time instruction-condition checks.
The early generator headers therefore include the regenerated options header,
and the RTL test checks that the condition table is populated. Compiler and
generator objects use `-O2`. Sources emitted by generators retain their C filename
extensions so the GCC driver selects the intended language.

The newly built compiler produces its own libgcc, libgcov, crtbeginT and crtend.
The TCC varargs compatibility object needed by the first compiler's input libc
is no longer part of this runtime. Both the compiler execution runtime and its
output sysroot use musl 1.2.5. Runnable `:gcc` and `:cpp` targets supply explicit
tool and header paths; the raw installed driver requires those prefixes.

All 41 package tests pass, along with the preceding stage's RTL test. They cover
regenerated sources, generator diagnostics, C at O0/O2, preprocessing and piped
compilation, static linking, separate archives and weak symbols, arithmetic,
constructors, threads/TLS, forced and signal-frame unwinding, math, Unicode, and
failure when declared tools, headers, or libraries are missing. This is a libc
transition rebuild, not the later GCC 4.7 stage2/stage3 comparison.

```
buck2 test cellar//bootstrap/stage1/gcc40-rebuilt: --local-only -j 8
buck2 build cellar//bootstrap/stage1/gcc40-rebuilt:installation
```
