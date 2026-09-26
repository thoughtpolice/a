<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native GCC 10.5.0 bootstrap

GCC 10.5.0 is the next compiler after GCC 4.7.4, following live-bootstrap's
route. GCC 10 is written in C++98, so GCC 4.7's C++ compiler and libstdc++ can
build it, and GCC 10 in turn can build compilers that need C++11. BUILD calls
the shared [GCC port](../gcc/README.md) for three stages with GNU binutils
2.30; `config.bzl` holds the reviewed configure answers and `sources.bzl` the
file lists. The C++ standard library is in
[libstdcxx10](../libstdcxx10/README.md).

GCC 10 already carries the musl target support that the GCC 4.7 port patched
in, so no live-bootstrap target patch is needed.

## What differs from the shared port

- Most `gcc/` sources and all libcpp sources are C++ named `.c`, as are the
  sources the generators write. The port keeps `.cc` for the few sources the
  release already names so.
- `makeucnid` reads the Unicode 6.3.0 data it last generated `ucnid.h` from,
  downloaded beside the release, and `generators/wcwidth.c` reads the
  Unicode 12.1.0 data GCC ships.
- gengtype links `version.c`, and GCC's `gcov-iov` writes `gcov-iov.h`. The
  GCC 4.7 port's `gcov-program.patch` changes only the generator-name comment
  in that header, so that it records no action path.
- The GCC 4.7 port's `tmpdir.patch` applies to libiberty unchanged.
- `auto-host.h` describes GNU binutils 2.30. gas links the bundled zlib and
  accepts `--compress-debug-sections=zlib-gnu`.
- Split stacks are rejected. GCC 10 would use glibc's `%fs:0x70` slot, which
  musl's thread control block does not have, so `tm.h` removes split-stack
  support, and a test checks that `cc1` rejects `-fsplit-stack`.

```
buck2 test cellar//bootstrap/stage1/gcc10: cellar//bootstrap/stage1/libstdcxx10:
buck2 test cellar//bootstrap/stage1/gcc10:stage-comparison cellar//bootstrap/stage1/libstdcxx10:stage-comparison
```
