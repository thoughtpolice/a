<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Static GCC 13.5.0 C++ libraries

BUILD declares libstdc++'s 196 translation units with their per-directory and
per-file Makefile.am flags, and the four static archives an upstream
`--disable-shared` build produces: `libstdc++.a` (189 objects, including the
C++20 time zone database), `libsupc++.a` (65), `libstdc++fs.a`, the
Filesystem TS (6), and `libstdc++exp.a`, the contracts support with the
Filesystem TS (7). Each GCC 13 stage builds its own libraries. No configure
or Make process runs.

The reviewed x86_64 musl 1.2.5 `config.h` follows the libstdc++ 10 port and
adds GCC 13's probes, among them `getentropy`, `secure_getenv`, `uselocale`,
POSIX semaphores and the `init_priority` attribute, which the installed
`<iostream>` relies on. Upstream's sed pipeline writes `bits/c++config.h` and
the gthread headers. The installed header tree adds C++20 and C++23
facilities such as `<format>`, `<expected>` and `<stacktrace>`; as upstream
without `--enable-libstdcxx-backtrace`, `std::stacktrace` has no backtrace
library.

`tzdb.cc` embeds the time zone data GCC ships, wrapped in a raw string
literal as `src/c++20/Makefile.am` does. This is
`--with-libstdcxx-zoneinfo=static`: the library searches no host zoneinfo
directory unless a program installs an override.

`cxx11-ios_failure` is repointed at the old-ABI failure vtable in assembly,
as in the libstdc++ 10 port, and assembled by binutils 2.41's gas like the
rest of the library. Neither of the GCC 4.7 port's patches is needed.

Sixteen tests run at `-O0` and `-O2` across eight programs: the libstdc++ 10
port's seven, which this package shares, and C++20 ranges, `std::format`, the
time zone database, calendar types, `jthread`, latches, barriers and
semaphores.

```
buck2 test cellar//bootstrap/stage1/libstdcxx13:
buck2 run cellar//bootstrap/stage1/libstdcxx13:stage3-g++ -- --version
```
