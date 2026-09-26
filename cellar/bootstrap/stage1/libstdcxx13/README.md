<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Static GCC 13.5.0 C++ libraries

BUILD calls the shared [libstdc++ port](../gcc/README.md#libstdc) for each
GCC 13 stage. `sources.bzl` lists libstdc++'s translation units with their
per-directory and per-file Makefile.am flags, and the installed headers.
The port builds the four static archives an upstream `--disable-shared`
build produces: `libstdc++.a`, including the C++20 time zone database,
`libsupc++.a`, `libstdc++fs.a`, the Filesystem TS, and `libstdc++exp.a`,
the contracts support with the Filesystem TS.

The reviewed x86_64 musl 1.2.5 `config.h` in `config.bzl` follows the
libstdc++ 10 port and adds GCC 13's probes, among them `getentropy`,
`secure_getenv`, `uselocale`, POSIX semaphores and the `init_priority`
attribute, which the installed `<iostream>` relies on. The installed header
tree adds C++20 and C++23 facilities such as `<format>`, `<expected>` and
`<stacktrace>`; as upstream without `--enable-libstdcxx-backtrace`,
`std::stacktrace` has no backtrace library.

`tzdb.cc` embeds the time zone data GCC ships, wrapped in a raw string
literal as `src/c++20/Makefile.am` does. As with
`--with-libstdcxx-zoneinfo=static`, the library searches no host zoneinfo
directory unless a program installs an override.

binutils 2.41's gas assembles `cxx11-ios_failure`, like the rest of the
library. Neither of the GCC 4.7 port's patches is needed.

Besides the shared test programs, `tests/cxx20.cc` covers C++20 ranges,
`std::format`, the time zone database, calendar types, `jthread`, latches,
barriers and semaphores. `stage3-installation` lays out the final stage's
headers, archives and notices.

```
buck2 test cellar//bootstrap/stage1/libstdcxx13:
buck2 run cellar//bootstrap/stage1/libstdcxx13:stage3-g++ -- --version
```
