<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GCC 4.7.4's C++ libraries

Each of the three [GCC 4.7.4](../gcc47/README.md) stages builds its own static
`libstdc++.a` and `libsupc++.a`, including the C ABI demangler, from gcc47's
extracted archive. BUILD sets each source's language standard and template
flags. `sources.bzl` names the library objects and the installed headers, and
derives the list of archive files from them. The bootstrapped sed and catm
write the configuration and gthread headers. No configure or Make process
runs. The headers cover C++98 and C++11, TR1, TR2, the GNU extensions and the
debug and profile modes; OpenMP's parallel mode is left out.

The reviewed LP64 musl configuration uses generic locale and stdio support,
POSIX threads, native atomics and TLS. It uses the ordinary 64-bit file APIs,
since `_GLIBCXX_USE_LFS` selects `*64` aliases that musl does not have.
`patches/gthr.patch` applies the reference's strong pthread references, which
keep threading working in static links. The generic locale model provides the
C and POSIX locales and custom C++ facets, not named system locales. The
library implements C++11 as far as GCC 4.7 does.

`:stage1-g++`, `:stage2-g++` and `:stage3-g++` run each stage's C++ driver
with that stage's native tools, runtime and libraries and these headers.

## Tests

Each stage builds the test programs at `-O0` and `-O2`. They cover exceptions
across translation units, cleanups, nested exceptions and exception pointers;
RTTI and demangling; C++98 containers and GNU policy-based trees; C++11
ownership, unordered containers, functions, random numbers and arithmetic;
threads, condition variables, futures, `call_once` and local static
initialization; and narrow and wide streams, custom locale facets and sparse
file seeks past 2 GiB. The ABI program links without default libraries,
naming libsupc++, libgcc and musl itself, and checks global destructor order.

`:stage-comparison` compares every stage 2 and stage 3 library object and
both archives byte for byte.

```
buck2 test cellar//bootstrap/stage1/libstdcxx:
```
