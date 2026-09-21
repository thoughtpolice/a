<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Source-regenerated native bootstrap

Principal recipe reference: live-bootstrap
`dd8ac27bf959344b9bcf5e876bdd7716879bbc70`.

Package composition, sources, configuration, generator invocations, library order,
and compiler predecessors are declared in BUILD files. Reusable action mechanics
and static source inventories live in cellar-local Starlark files. No package
build invokes configure, Make, or kaem.

The initial source-preparation gate downloads Mes 0.27 and NYACC 1.00.2-lb1 using
pinned SHA256 hashes and extracts them with stage0 tools. Mes's source tree is
assembled from an explicit manifest, with no psyntax.pp or psyntax.pp.header.
Its compiler configuration contains no absolute workspace prefix. NYACC's eight
C parser tables are regenerated from grammar sources with M2-built mes.bin.
The CPP generator precedes C99/C99x; C99cx is independent. No shipped mach.d table
is copied into the modules consumed by MesCC. Mes then passes through the existing
three compiler stages and compares the last two interpreter executables.

Validation:

```
buck2 test cellar//bootstrap/stage0-posix/seeds/linux-amd64: \
  cellar//bootstrap/mes:hello-test cellar//bootstrap/mes:mes-fixed-point --local-only -j 8
```

The native stage1 target is x86_64 Linux. Compiler execution runtime and the
compiler's output sysroot are distinct toolchain properties. Object and archive
providers check Mes versus ELF formats and ABI compatibility during analysis.
The early archive rule preserves explicit member order and rejects truncated-name
collisions. Compiler commands retain their RunInfo artifact dependencies, including
MesCC, which has no default executable artifact.

The immutable simple-patch adaptation is based on the pinned reference's MIT
source. It requires exactly one nonempty before block, checks allocation and I/O,
and writes a distinct output artifact. Its tests exercise replacement plus missing,
ambiguous, empty, and oversize patterns.

The target endpoint remains GCC 4.7.4 C/C++, binutils 2.30, musl 1.2.5, and the
userland specified by the implementation plan. This foundation does not claim that
those downstream packages have been built. Gates still required include the native
TCC fixed point, runtime feature tests, source-closure tracing, and relocation to a
different absolute workspace path.

Closure review:

```
buck2 bxl cellar//bootstrap/audit.bxl:closure -- \
  --target cellar//bootstrap/mes:mes-fixed-point > /tmp/mes-closure.json
python3 cellar/bootstrap/audit-loads.py
```

The BXL report includes every configured target's rule-definition path, action
owner and command, and transitive Starlark loads. Buck automatically injects its
bundled prelude into modules and the repository's noprelude shim into BUILD files;
the audit reports those infrastructure loads explicitly. No rule defined there
is permitted in the configured dependency closure. The supplementary source audit
rejects explicit imports outside cellar, including unused imports.
