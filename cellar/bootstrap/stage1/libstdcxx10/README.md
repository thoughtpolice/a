<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Static GCC 10.5.0 C++ libraries

BUILD declares libstdc++'s 189 translation units with their per-directory and
per-file Makefile.am flags, and the three static archives an upstream
`--disable-shared` build produces: `libstdc++.a` (183 objects), `libsupc++.a`
(65) and `libstdc++fs.a`, the Filesystem TS (6). `std::filesystem` itself is in
`libstdc++.a`. Each GCC 10 stage builds its own libraries. No configure or Make
process runs.

The reviewed x86_64 musl 1.2.5 `config.h` selects the generic locale and stdio
models, POSIX threads, native atomics, TLS, futexes and the filesystem
operations musl provides. As upstream does for a static build, there is no
symbol versioning and no `-D_GLIBCXX_SHARED`. Upstream's sed pipeline writes
`bits/c++config.h` and the gthread headers. The installed header tree includes
C++98 through C++17, TR1/TR2, GNU extensions, policy-based data structures,
parallel mode and the parallel STL headers, with the target headers flattened
into `bits/`.

`cxx11-ios_failure` is compiled to assembly, has its type_info repointed at
the old-ABI failure vtable, and is then assembled, as upstream does, so that
old-ABI handlers still catch iostream failures.

Neither of the GCC 4.7 port's patches is needed. GCC 10 already selects the
generic OS headers for musl, and its unpatched `os_defines.h` uses strong
pthread references, so threads work in static links.

Fourteen tests run at `-O0` and `-O2` across seven programs: exceptions across
translation units, the standalone ABI library, C++98 containers, C++11
facilities, threads, streams, and C++17 (`std::filesystem`, `variant`,
`optional`, `any`, `charconv`, polymorphic allocators and `shared_mutex`).

```
buck2 test cellar//bootstrap/stage1/libstdcxx10:
buck2 run cellar//bootstrap/stage1/libstdcxx10:stage3-g++ -- --version
```
