<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# LLVM 23.1.0

This package builds LLVM from the `llvm-project-23.1.0.src.tar.xz` release
tarball with the final [GCC 13.5 stage](../gcc13/README.md), its
[C++ library](../libstdcxx13/README.md), binutils 2.41 and musl 1.2.5. The
`gcc` stage delivers Clang, LLD, llvm-ar and the TableGen generators they
need, with the AArch64 and X86 back ends, statically linked for x86_64 Linux.
`:gcc-toolchain` holds `bin/clang`, `bin/ld.lld` and Clang's resource headers
under `lib/clang/23/include`, where Clang finds them beside itself. That Clang
then builds musl and Clang's own runtimes, and with them LLVM again, twice.
The third build reproduces the second byte for byte, and `:toolchain`
installs it: a Clang toolchain that built itself and needs nothing from GCC.

```sh
buck2 test @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1/llvm:
```

## Inventory

LLVM's own Bazel build files, under `utils/bazel/llvm-project-overlay` in
the tarball, describe every library: its sources, include directories,
defines and TableGen invocations. [inventory.py](inventory.py) evaluates them
for one configuration (x86_64 Linux, musl, GCC, the AArch64 and X86 targets,
zlib and zstd off) and writes the closure of the requested tools to
[inventory.bzl](inventory.bzl). No build runs it. `buck2 run` runs it with
the [bootstrapped Python](../python/README.md) and rewrites the inventory
from the extracted tarball for the tools it already names, and for any more
given after `--`:

```sh
buck2 run cellar//bootstrap/stage1/llvm:inventory
buck2 run cellar//bootstrap/stage1/llvm:inventory -- //llvm:llvm-nm
```

From inside `cellar/`, which is a project of its own, the same command
extracts the tarball again into `cellar/buck-out`.

The evaluation follows Bazel's rules. Globs stay within their package,
selects resolve against the configuration, and a library's `defines` and
`includes` also reach every library that depends on it. TableGen receives
the include directories of its `td_library` dependencies, the workspace root
and the directory of its input. Headers that exist only in the overlay, such
as `llvm/Config/config.h`, are taken from it.

The runtimes have no Bazel overlay. The inventory instead records the
literal source and header lists their CMake files assign, such as the headers
libc++ installs and the generic compiler-rt builtins, and
[runtimes.bzl](runtimes.bzl) makes the configuration's choices among them.

The inventory holds no LLVM source text. Files the overlay writes from
templates are recorded as recipes, which [defs.bzl](defs.bzl) applies to the
tarball with sed and catm. Only the few lines the overlay writes itself,
such as `VCSRevision.h`, are inline.

## Configuration

[defs.bzl](defs.bzl) instantiates the inventory for one compiler stage.
Every library becomes an archive of per-source objects, and every TableGen
invocation an action that runs the stage's own generator. Generated headers
form one tree per generator: a library compiles against the tree of the
latest generator it needs, so `llvm-min-tblgen` and `llvm-tblgen` never wait
on their own outputs.

The build matches an LLVM release configuration: `-O2 -DNDEBUG`, without
assertions, ABI-breaking checks, exceptions or RTTI. The overlay's host and
default triples name glibc; this build uses `x86_64-unknown-linux-musl`.
Binaries link with an 8 MiB `PT_GNU_STACK` size, because musl's 128 KiB
default thread stack is too small for LLVM's recursive passes and musl takes
new threads' stack size from that header. They allocate through
[mimalloc](../mimalloc/README.md), like GCC 13's compilers.

The tarball is decompressed and extracted in one action, keeping only the
projects this build reads and the overlay, without their test suites, unit
tests or manuals: 23,000 of its 197,000 files and about a seventh of its size.
The inventory test checks that the inventory still comes out the same from that
tree.

## Runtimes

[runtimes.bzl](runtimes.bzl) builds, with one stage's Clang and llvm-ar, the
C library and runtimes that a static program links against. Each follows
what its upstream build does for static x86_64 Linux with musl, at `-O2` and
without warning flags.

- musl 1.2.5, from the sources and generated tables of
  [the GCC-built musl](../musl12/README.md), with the flags musl's configure
  picks for Clang: freestanding C99, `-O2` with `-O3` for its string,
  allocation and internal code, and no unwind tables.
- compiler-rt's builtins, `clang_rt.crtbegin.o` and `clang_rt.crtend.o`. The
  builtins are the generic, 128-bit float, bfloat16 and x87 sources, with the
  x86_64 versions replacing generic ones as `filter_builtin_sources` does,
  compiled position independent and hidden as a runtimes build does.
- libunwind, libc++abi and libc++, with libc++'s `__config_site` written from
  its template as CMake's `configure_file` would: the stable ABI, musl,
  threads, every optional library feature, the time zone database in
  `libc++experimental.a`, and no hardening by default. `libc++.a` also holds
  libc++abi, as `LIBCXX_ENABLE_STATIC_ABI_LIBRARY` arranges, because a static
  link names only `-lc++`. libunwind and libc++abi keep their assertions, as
  upstream builds them by default.
- mimalloc, compiled as for GCC 13.

Clang compiles them against musl's headers and the
[Linux UAPI headers](../linux-headers/README.md); libc++'s atomics wait with
futexes from `<linux/futex.h>`. Upstream's CMake would also give libunwind,
libc++abi and libc++ pragmas asking the linker for `-ldl` and `-lpthread`;
musl's `libc.a` holds those functions, so this build leaves them out. Clang
enables no stack protector by default, so musl's startup code needs no
exceptions either.

A stage's compilers are the previous stage's Clang, LLD and llvm-ar: the
`stage2-` compilers come from the `gcc` stage, and the `stage3-` compilers
from `stage2`. They link with LLD directly and ask it for the
`PT_GNU_EH_FRAME` header libunwind reads, as Clang's driver does. A stage's
runtimes are what its compilers build. `libcxx-headers` holds the headers
libc++ and libc++abi install, with the generated configuration, and
`libunwind-headers` those of libunwind.

## Self-build

The `gcc` stage is the first of three. Each later stage is the whole
inventory again, compiled by the previous stage's Clang, archived by its
llvm-ar and linked by its LLD against the runtimes that Clang built, with
mimalloc compiled by the same Clang. Both use the `gcc` stage's flags.

- `stage2` is compiled by the `gcc` stage's Clang.
- `stage3` is compiled by `stage2`'s Clang.

The `gcc` stage's Clang and `stage2`'s Clang come from the same source, so
they should translate alike even though GCC compiled one and Clang the other.
Then `stage3` comes out the same as `stage2`, and the `compare-` tests check
that byte for byte for every program, runtime library and startup file.

## Installation

`:toolchain` installs `stage3` and its runtimes as a native installation
that is its own sysroot.

- `bin/clang`, `bin/ld.lld`, `bin/llvm-ar` and
  `bin/x86_64-unknown-linux-musl.cfg`. `bin/clang++` and `bin/llvm-ranlib`
  are small launchers, built from [alias.c](alias.c), that run `clang` and
  `llvm-ar` under their own names, which choose the driver and archiver
  modes. Buck keeps no links inside an installation, and copies would cost
  150 MB.
- Clang's resource headers and compiler-rt under `lib/clang/23`.
- libc++, libc++abi, libc++experimental and libunwind under
  `lib/x86_64-unknown-linux-musl`, and libc++'s headers under
  `include/c++/v1` and `include/x86_64-unknown-linux-musl/c++/v1`.
- musl's headers, libraries and startup files under `include` and `lib`,
  with the Linux UAPI headers and `libunwind.h` beside musl's. Clang
  searches a musl sysroot's headers before its own, so libunwind's
  `unwind.h`, which lacks GCC's `_Unwind_Ptr` and kin, stays out in favor
  of Clang's. [headers.sh](headers.sh) copies these header trees into one
  `include` directory, since musl and the kernel share directories such as
  `scsi`, and fails if two trees hold the same file.
- The notices of every project it holds, under `share/licenses`.

Clang reads the configuration file named for its default target from its
own directory. The file names the installation as the sysroot and selects
compiler-rt, libunwind, libc++, LLD and static linking, so `bin/clang` and
`bin/clang++` build static programs from nothing outside the installation.

## Tests

`gcc-clang` compiles the installation's C and C++ acceptance programs with
Clang, against musl and libstdc++ 13, links them statically with LLD and GCC
13's runtime, and runs them: threads, TLS, varargs, iconv, setjmp, the STL,
RTTI and exceptions. It also checks both versions, the musl default target,
and that `--target=aarch64-unknown-linux-musl` emits an AArch64 object.

For `stage2` and `stage3`, `-native-c-test`, `-native-cxx-test` and
`-runtimes-test` link the installation's acceptance programs and
[tests/runtimes.cc](tests/runtimes.cc) with LLD against only that stage's
runtimes, and compare their output: exceptions unwound by libunwind,
`thread_local` destructors, futex waits, LLVM libc's float parsing inside
libc++, `std::filesystem` and `std::format`, and compiler-rt's 128-bit, half,
bfloat16 and x87 conversions and CPU detection.

`toolchain-test` uses only `:toolchain`, with no `PATH`. `clang` and
`clang++` build and run the same programs through the configuration file, a
C program walks its stack through `libunwind.h`, and a program links a
library that `llvm-ar` and `llvm-ranlib` made. Every musl and Linux header
must lie in the installation unchanged, since the two share directories such
as `scsi`. Every absolute path the driver gives the compiler and linker must
lie in the installation, the installed tools and the programs they link must hold no code GCC compiled, and
`--target=aarch64-unknown-linux-musl` must still emit an AArch64 object.

`gcc-tblgen` checks both generators' versions and optimized, assertion-free
builds. `llvm-tblgen` must reproduce the value type table that the build took
from `llvm-min-tblgen`, emit the intrinsic enumeration, and reject an
undefined class. `inventory-test` reruns inventory.py on the extracted
tarball with the binaries the inventory names, and fails if the result
differs from the committed file.
