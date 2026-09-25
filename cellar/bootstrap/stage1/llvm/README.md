<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# LLVM 23.1.0

This package builds LLVM from the `llvm-project-23.1.0.src.tar.xz` release
tarball with the final [GCC 13.5 stage](../gcc13/README.md), its
[C++ library](../libstdcxx13/README.md), binutils 2.41 and musl 1.2.5. The
`gcc` stage delivers `llvm-min-tblgen` and `llvm-tblgen`, statically linked
for x86_64 Linux.

```sh
buck2 test @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1/llvm:
```

## Inventory

LLVM's own Bazel build files, under `utils/bazel/llvm-project-overlay` in
the tarball, describe every library: its sources, include directories,
defines and TableGen invocations. [inventory.py](inventory.py) evaluates them
for one configuration (x86_64 Linux, musl, GCC, the AArch64 and X86 targets,
zlib and zstd off) and writes the closure of the requested tools to
[inventory.bzl](inventory.bzl). It runs by hand on the host, never in the
build:

```sh
python3 inventory.py path/to/llvm-project-23.1.0.src inventory.bzl \
  //llvm:llvm-min-tblgen //llvm:llvm-tblgen
```

The evaluation follows Bazel's rules. Globs stay within their package,
selects resolve against the configuration, and a library's `defines` and
`includes` also reach every library that depends on it. TableGen receives
the include directories of its `td_library` dependencies, the workspace root
and the directory of its input. Headers that exist only in the overlay, such
as `llvm/Config/config.h`, are taken from it.

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
new threads' stack size from that header.

## Tests

`gcc-tblgen` checks both generators' versions and optimized, assertion-free
builds. `llvm-tblgen` must reproduce the value type table that the build took
from `llvm-min-tblgen`, emit the intrinsic enumeration, and reject an
undefined class. `inventory-test` reruns inventory.py on the extracted
tarball with the binaries the inventory names, and fails if the result
differs from the committed file.
