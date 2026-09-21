<!--
SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Historical Foundation proposal (superseded)

The active native bootstrap design is described in [stage1/README.md](stage1/README.md).
The versions and script-based package wrappers below are historical research,
not implementation instructions for the current port.

# Stage1 Bootstrap — Buck2 Port Plan

## Context

We have a working 3-stage mescc build in the Buck2 monorepo (under `cellar/bootstrap/stage0-posix/` and `cellar/bootstrap/mes/`). The reference Nix implementation at `/home/exedev/src/foundation/src/stages/stage1/` describes the next layer: ~26 packages that lift us from mescc up through tinycc, musl, and gcc-13 to a self-hosting modern toolchain.

Goal: port every stage1 package to Buck2 `BUILD` files under `cellar/bootstrap/stage1/`, targeting **linux-amd64** first (arm64 is a follow-up). Foundation's Nix code is the authoritative reference for versions, patches, build flags, and dependency ordering — we mirror its decisions faithfully, only adjusting where i686 vs. amd64 forces our hand.

The work is large (~42 actual build targets once you count multi-pass variants) but highly repeatable: 5–10 shared Buck2 macros carry most of the weight, and the rest is per-package `BUILD` files that mostly vary in download URL, patches, and configure flags.

## Strategy

### The three builder eras

Foundation uses three "builder" abstractions, and our Buck2 port needs the equivalents:

| Era | Nix builder | Needs | Buck2 macro to create |
|---|---|---|---|
| A | `kaem.build` | kaem + mescc-tools + tinycc-mes in PATH | `kaem_build` |
| B | `bash.boot.build` | bash v2 + tinycc-musl + early coreutils in PATH | `bash_boot_build` |
| C | `bash.build` | bash v5 + gcc + full utilities in PATH | `bash_build` |

Each macro is a thin wrapper around `ctx.actions.run` (or a `genrule` with a carefully constructed PATH) that composes the build-time toolchain from a `deps` list and runs a build script. Model: the existing custom rules in `cellar/bootstrap/stage0-posix/stage0.bzl` and `mescc-tools-extra/defs.bzl` (see `__cc`, `__M2`, `__hex2`).

### Source + patch handling

Reuse `shims.http_archive` from `buck/shims/shims.bzl` for tarball downloads (SHA256 verified). For patches, use a `shims.genrule` that invokes stage0-built `patch` (once available) or a shell `patch -p1 < ...` in the build script. Copy each `patches/*.patch` verbatim from foundation into `cellar/bootstrap/stage1/<pkg>/patches/`.

### The canonical build order

Derived from foundation's `stage1/default.nix` `includes` array and confirmed against live-bootstrap conventions. The order must be respected — several packages have multi-pass builds that **depend on their own prior output being rebuilt** after a toolchain upgrade (musl → tinycc-musl → musl-1.2.4).

---

## Phase 0 — Infrastructure (no packages ported yet)

Create the shared Buck2 plumbing before touching any package. Without these, every package BUILD would be copy-paste boilerplate.

**Files to create:**
- `cellar/bootstrap/stage1/PACKAGE` — package metadata
- `cellar/bootstrap/stage1/BUILD` — top-level filegroup `:all`
- `cellar/bootstrap/stage1/defs.bzl` — shared macros:
  - `kaem_build(name, script, srcs, deps, tools)` — runs kaem with mescc-tools + mescc in PATH
  - `bash_boot_build(name, script, srcs, deps)` — bash-v2 era builder (needs Phase A bash-boot first)
  - `bash_build(name, script, srcs, deps)` — bash-v5 era builder (needs Phase B bash first)
  - `tarball_source(name, url, sha256, strip_prefix)` — thin wrapper around `shims.http_archive`
  - `apply_patches(name, src, patches)` — genrule that runs `patch -p1` for each patch file
- `cellar/bootstrap/stage1/sources.bzl` — centralized URL + SHA256 map, mirroring `foundation/src/stages/stage1/*/default.nix` version pins (see "Version pin table" below)

**Precheck (do first, before writing macros):**
- Confirm `//cellar/bootstrap/mes:mescc` (or equivalent) exposes a runnable mescc binary as a Buck2 target; read `cellar/bootstrap/mes/BUILD` and `cellar/bootstrap/mes/defs.bzl` to find the exact label.
- Confirm `//cellar/bootstrap/stage0-posix:<arch>` exposes kaem, mescc-tools, mescc-tools-extra as a usable filegroup. Read `cellar/bootstrap/stage0-posix/stage0.bzl` — the `stage0_platform` macro is the handle.

**Verification:** `buck2 build //cellar/bootstrap/stage1:all` succeeds with no targets yet (just proves the files parse). Then write a dummy `hello.kaem` target that echoes "hello" through kaem_build to prove the macro works end-to-end.

---

## Phase A — kaem-era packages (mescc → tinycc-mes)

All built with `kaem_build`. Each subdirectory under `cellar/bootstrap/stage1/` gets its own `BUILD` + optional `patches/` subdir mirroring foundation.

| # | Package | Version | Patches | Why here |
|---|---|---|---|---|
| A1 | `nyacc` | 1.00.2 | none | Parser gen; first port — proves kaem_build + http_archive pattern |
| A2 | `mes` (compiler + libs) | 0.25 | none | Produces `mescc` + mes-libc used by everything below |
| A3 | `ln-boot` | (custom, 16-line C) | none | Minimal shakedown of mescc-compile-C path |
| A4 | `tinycc-boot` (4 passes: 0→3) | 2023-04-20 | 3 patches | Self-hosting TCC chain; largest kaem-era target |
| A5 | `tinycc-mes` | 2023-04-20 | (same 3) | Full C99 TCC compiled with tinycc-boot |
| A6 | `gnupatch` | 2.5.9 | none | Need for applying later patches *inside* builds |
| A7 | `gnumake-boot` | 4.4.1 | 3 patches | Enables Makefile-based builds |
| A8 | `coreutils-boot` | 9.4 | (inline sed) | Basic POSIX tools (install, cp, mv) |
| A9 | `heirloom-devtools` | 070715 | subset of 11 | Provides sed/ed/nawk for configure scripts |
| A10 | `bash-boot` | 5.2.15 | 1 patch | Needed before we can switch to `bash_boot_build` |
| A11 | `gnused-boot` | 4.2 | none | Sed for build scripts |
| A12 | `gnugrep` | 2.4 | none (custom Makefile) | Grep for configure scripts |
| A13 | `gnutar-boot` | 1.35 | none | Tar (tcc-compiled) |
| A14 | `gzip` | 1.2.4 | none | Old gzip, fits mescc era |

**First-wedge detail (A1–A3):** after Phase 0 ships, port these three back-to-back to validate the macro set before committing to the full chain. If the pattern doesn't feel right by A3, stop and refactor the macros — don't propagate pain into A4–A14.

**Reference files for A1–A3:**
- `/home/exedev/src/foundation/src/stages/stage1/nyacc/default.nix`
- `/home/exedev/src/foundation/src/stages/stage1/mes/{default,compiler,libs,libc,sources}.nix`
- `/home/exedev/src/foundation/src/stages/stage1/ln-boot/{default.nix,main.c}`

---

## Phase B — bash.boot-era packages (musl chain + rebuilds)

All built with `bash_boot_build`. Introduces the two-pass musl bootstrap.

| # | Package | Version | Notes |
|---|---|---|---|
| B1 | `musl-boot0` | 1.1.24 | Built with `tinycc-mes` |
| B2 | `tinycc-musl-boot0` | 2023-04-20 | TCC rebuilt against musl-boot0 |
| B3 | `musl-boot` | 1.1.24 | Second musl pass, against tinycc-musl-boot0 |
| B4 | `tinycc-musl` | 2023-04-20 | Mature TCC — used by most Phase B packages |
| B5 | `gawk-boot` | 5.2.2 | 1 patch |
| B6 | `gnused` (final) | 4.2 | — |
| B7 | `gnumake` (final) | 4.4.1 | Same 3 patches as A7 |
| B8 | `gnutar-musl` | 1.35 | — |
| B9 | `gawk` (final) | 5.2.2 | — |
| B10 | `xz` | 5.4.3 | — |
| B11 | `diffutils` | 3.8 | — |
| B12 | `coreutils` (final) | 9.4 | — |
| B13 | `binutils` | 2.41 | 1 patch (deterministic) |
| B14 | `findutils` | 4.9.0 | inline sed |
| B15 | `heirloom` (final) | 070715 | 11 patches |
| B16 | `bash` (final) | 5.2.15 | 1 patch |

---

## Phase C — bash.build-era packages (gcc and beyond)

All built with `bash_build`. The GCC staircase (4.6 → 8 → 13.2) is the centerpiece.

| # | Package | Version | Notes |
|---|---|---|---|
| C1 | `gcc` v4.6.4 (C only) | 4.6.4 | 1 patch + GMP 4.3.2 + MPFR 2.4.2 + MPC 1.0.3 |
| C2 | `musl` (final) | 1.2.4 | Rebuild with gcc |
| C3 | `bzip2` | 1.0.8 | — |
| C4 | `gcc` v4.6.4 (C++) | 4.6.4 | Same sources, adds C++ |
| C5 | `gnutar` (final) | 1.35 | — |
| C6 | `gcc` v8 | 8.5.0 | Intermediate compiler |
| C7 | `gcc` (final) | 13.2.0 | + GMP 6.3.0 + MPFR 4.2.1 + MPC 1.3.1 + ISL 0.24 |
| C8 | `gnum4` | 1.4.19 | Needs gcc |
| C9 | `bison` | 3.8.2 | Needs gnum4 |
| C10 | `linux-headers` | 6.5.6 | — |
| C11 | `zlib` | 1.3 | — |
| C12 | `python` | 3.12.0 | 1 patch, needs zlib |

---

## Critical files

### New files (created by this work)
- `cellar/bootstrap/stage1/BUILD` — top-level `:all` filegroup
- `cellar/bootstrap/stage1/PACKAGE`
- `cellar/bootstrap/stage1/defs.bzl` — shared macros (see Phase 0)
- `cellar/bootstrap/stage1/sources.bzl` — version/URL/SHA256 table
- `cellar/bootstrap/stage1/<pkg>/BUILD` — one per package (~42 of them)
- `cellar/bootstrap/stage1/<pkg>/patches/*.patch` — copied verbatim from foundation

### Reference-only (read but don't modify)
- `/home/exedev/src/foundation/src/stages/stage1/**` — source of truth for versions, patches, build recipes
- `/home/exedev/src/foundation/src/builders/{kaem,bash,raw}/default.nix` — implementation reference for our macros
- `cellar/bootstrap/stage0-posix/stage0.bzl` — custom-rule idiom we mimic in `defs.bzl`
- `cellar/bootstrap/stage0-posix/mescc-tools-extra/defs.bzl` — see `__cc` rule for how to run a mescc-family compiler via `ctx.actions.run`
- `cellar/bootstrap/mes/BUILD` + `defs.bzl` — where `mescc` is exposed as a target
- `buck/shims/shims.bzl` — `http_archive`, `genrule`, `copy_files`, `filegroup` already usable
- `buck/third-party/by-name/*/zlib/BUILD`, `.../sqlite/BUILD`, `.../zstd/BUILD` — examples of `http_archive` + `cxx_library` idiom

---

## Reused patterns (don't reinvent)

- **Tarball download:** `shims.http_archive(name="src", urls=[...], sha256=..., strip_prefix=..., sub_targets=[...])` — see `buck/third-party/by-name/zl/zlib/BUILD`.
- **Patched files:** `shims.genrule` producing the patched source, consumed by downstream rules — see `buck/third-party/.../isocline/BUILD` for the sed-based equivalent; for real patch files use `patch -p1` invocation once A6 (`gnupatch`) is available, and a shell `sed`/`awk` workaround before that.
- **Custom compiler invocation:** `rule(impl=fn, attrs=...)` with `ctx.actions.run` — see the `__cc` rule in `cellar/bootstrap/stage0-posix/mescc-tools-extra/defs.bzl` for the canonical template (declare output, run tool, return `[DefaultInfo, RunInfo]`).
- **Multi-step pipeline:** chain rules where one rule's output is another's `src` — see `stage0_binaries` in `cellar/bootstrap/stage0-posix/stage0.bzl`.

---

## Execution order (piece by piece)

1. **Phase 0 infrastructure** — land `defs.bzl`, `sources.bzl`, top-level BUILD, and prove with a dummy kaem hello-world. No packages yet.
2. **Phase A wedge: A1–A3** — nyacc, mes, ln-boot. Refactor macros if needed after A3.
3. **Phase A tail: A4–A14** — tinycc-boot chain first (A4–A5), then the utility ports.
4. **Phase B: B1–B16** — musl + tinycc-musl two-pass, then utility finals.
5. **Phase C: C1–C12** — gcc staircase and final packages.

Land each package as an independent commit (`stage1: port <pkg>`) so bisection stays useful.

---

## Verification

After each phase:
- `buck2 build //cellar/bootstrap/stage1:all` succeeds.
- `buck2 build //cellar/bootstrap/stage1/<pkg>:install` succeeds for the package just added.
- `buck2 test //cellar/bootstrap/stage1/<pkg>:version` — a `command_test` that runs the built binary with `--version` (for packages that produce one) and compares output to a golden string. Mirrors the stage0 `answer_test` pattern.
- Read `buck2 build` output to confirm the build is hermetic: no references to `/usr/include`, `/usr/lib`, system `sh`, or host compilers.

End-to-end gate (once Phase C lands):
- `buck2 build //cellar/bootstrap/stage1:gcc` produces a gcc 13.2 that can compile a hello-world against the stage1 musl.
- Reproducibility check: two clean `buck2 clean && buck2 build //cellar/bootstrap/stage1:all` runs produce byte-identical outputs (mirror the existing `scripts/check-reproducibility.sh` approach from foundation).

---

## Risks & open questions

- **Patches are i686-coded in places.** Foundation targets i686-linux; some patches (especially musl, tinycc, heirloom meslibc workarounds) may have arch-specific hunks. We may need to adjust or add amd64-equivalent patches. Flag on first failure per package rather than pre-emptively rewriting.
- **`bash_boot` chicken-and-egg.** `bash_boot_build` macro can't be usefully defined until A10 (bash-boot) ships. Strategy: Phase A packages A1–A10 all use `kaem_build` with bash-boot absent; A11+ can assume bash-boot exists. This matches foundation's layering.
- **`patch` binary bootstrapping.** Until A6 lands, we can't run `patch` inside a build. Options: (a) ship patched sources via `genrule` + `sed`/`awk`; (b) commit pre-patched tarballs (ugly); (c) use kaem's built-in or mescc-tools-extra helpers. Foundation sidesteps this by using `patch` in bash.boot era, not kaem era — double-check whether any A-phase patches exist that aren't already covered by `sed` substitution in the foundation source. Fast scan suggests: heirloom has 11 patches but is A9 (after A6 gnupatch), so order works.
- **Mescc target label.** Precheck step exists in Phase 0 for a reason — we don't yet know the exact Buck2 label for mescc. Worst case: add a small wrapper in `cellar/bootstrap/mes/BUILD` to expose it cleanly.
- **arm64 rework later.** Version pins and patch choices should stay portable; architecture-specific bits belong in per-arch `select()` blocks in each package's BUILD. Don't bake amd64 assumptions into shared macros.
