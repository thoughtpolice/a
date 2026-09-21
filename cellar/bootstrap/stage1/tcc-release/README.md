<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Release TCC transition

TCC 0.9.27 is pinned by SHA256 and built with the validated native TCC 0.9.26
fixed point. `mes0` uses separate translation units and the predecessor's Mes
runtime. It also rebuilds Mes libc, CRT objects, getopt, and the release TCC
support library as `runtime-mes0`. The `mes1` corrective pass still uses TCC
0.9.26 to build the release compiler, linking it with that rebuilt Mes runtime.
It rebuilds the support library with 0.9.26 and exposes `mes1-compiler` with
`runtime-mes1`. Release TCC's self-hosting transition follows with musl.

The archive-open, weak-symbol-index, static-default, C99-array-qualifier, and
null-GOT-relocation fixes follow live-bootstrap revision
`dd8ac27bf959344b9bcf5e876bdd7716879bbc70`. The static x86_64 adaptations resolve
direct calls without an unrelocated PLT and fill GOT entries before section
tidying removes the relocation information. Upstream source licensing is retained
in each transformed file; the archive includes `COPYING`.

```
buck2 test cellar//bootstrap/stage1/tcc-release: --local-only -j 8
```

The sixteen checks cover version, malformed-input diagnostics, the native ABI,
integer/floating arithmetic, mixed varargs, separate compilation and archives,
weak symbols (including a weak-only archive member), and C99 array parameters.
Four of these checks run against the rebuilt runtime.
