<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Static AArch64 LLVM from the x86 seed chain

This extends the 229-byte x86_64 hex0 bootstrap to a static AArch64 Linux
LLVM 23.1 toolchain. It introduces no binary seed, host compiler, emulator,
configure invocation or Makefile-driven build.

| Stage | Compiler used | Where compilation executes | Result |
|---|---|---|---|
| `stage0` | Completed x86 LLVM | x86 Linux, remotely on an ARM client | Cross-built ARM LLVM and runtimes |
| `stage1` | ARM stage0 | ARM Linux | First native self-build |
| `stage2` | ARM stage1 | ARM Linux | Second native self-build |

Each stage builds musl 1.2.5, compiler-rt, libunwind, libc++abi, libc++,
libc++experimental and mimalloc. Stage0 runs x86 TableGen; the native stages
build and run their own ARM generators. Source processing with Python and sed
can independently remain on x86. Buck's toolchain and execution dependencies
express these choices in a single graph; see the
[platform guide](../../../platforms/README.md).

The ARM musl package selects the release's AArch64 assembly and headers and
shares the seed chain's regenerated Unicode and iconv tables. Linux's ARM64
UAPI is installed using the same source-built tools as the x86 headers, with
ARM syscall tables. Compiler-rt includes quad precision, CPU feature detection,
the AArch64 SME ABI routines and all upstream outline-atomic variants; the
baseline target remains ordinary AArch64, without requiring those optional
CPU features.

`inventory.bzl` is a compact delta against the x86 LLVM inventory, regenerated
from the same pinned release's Bazel overlay for an AArch64 host and Clang.
It changes the native target definitions and BLAKE3's sources and definitions.
The compiler still includes both X86 and AArch64 code generators.
`inventory-test` regenerates and checks this delta.

`:fixed-point` compares every delivered runtime archive and startup object,
mimalloc, Clang, LLD, llvm-ar and all three TableGen programs between stage1
and stage2. It is a **build dependency** of `:toolchain`, so building the
installation verifies the fixed point. LLD strips LLVM executables while
linking them; no x86-only strip program touches the ARM binaries.

The final installation is its own sysroot, with musl and Linux headers,
Clang's resource headers, all runtime libraries, `clang++` and `llvm-ranlib`
launchers, and each project's notices. The configuration beside Clang selects
compiler-rt, libunwind, libc++, LLD and static linking using paths relative to
the installation. The LLVM programs keep an 8 MiB thread stack.

```sh
buck2 build @mode//buildbuddy cellar//bootstrap:toolchain --show-output
buck2 test @mode//buildbuddy --unstable-allow-compatible-tests-on-re \
  cellar//bootstrap/stage2/aarch64/...
```

On an ARM client the first command selects this installation. Its explicit
label is `cellar//bootstrap/stage2/aarch64/llvm:toolchain`; the selector also
accepts `--modifier amd64` to request the original x86 installation.

Each stage's acceptance tests exercise C threads, TLS, varargs, iconv, setjmp,
C++ exceptions and RTTI, futex waits, thread-local destructors, filesystem and
formatting, wide floating-point conversions, half/bfloat16 and CPU detection.
`:toolchain-result` additionally compiles and runs programs through the
installed drivers with an empty PATH, tests libunwind, creates and links an
archive, checks ELF architecture/static linkage and stack size, checks the
driver's search paths, and emits an x86 object with the ARM compiler.

The programs driving native actions (`chdir`, `capture`, `compare`, and the
installation check) are themselves static ARM programs cross-built by stage0's
x86 compiler. They are orchestration tools, not inputs to the delivered
compiler or runtime libraries.
