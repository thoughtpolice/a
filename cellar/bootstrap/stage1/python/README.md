<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# CPython 3.14

The final GCC 13.5 stage and musl 1.2.5 build CPython 3.14.7 from its
release tarball, as one static executable with every extension module built
in. It serves the tests and tools that need Python, so they run on a
bootstrap executor instead of the host's `python3`. No configure or Make
process runs.

## Generated sources

The tarball ships sources that Python scripts generate: the PEG parser, the
bytecode interpreter's cases and metadata, the AST, token and keyword
tables, Argument Clinic's argument parsers, the frozen module list and the
global object tables, and the CJK codecs' and Unicode database's tables.
The build compiles them as shipped. The
`regeneration-test` then has the interpreter built from them run each
generator as `make regen-all`, `make clinic` and `make regen-limited-abi`
would, in a copy of the source tree, and requires the copy to equal the
original. Everything it regenerates matches byte for byte. The Levenshtein
test examples are drawn at random, so [tests/levenshtein.py](tests/levenshtein.py)
checks each shipped example against the generator's own distance function
and format instead. The Unicode database, the CJK codecs' mapping tables and
`stdlib_module_names.h` are not regenerated: the first two need the Unicode
consortium's data files, the last a build directory.

The frozen modules are not shipped. `_freeze_module`, built from everything
but the path configuration and the frozen modules, compiles and marshals
each one, as the Makefile's native build does.

## Configuration

[pyconfig.bzl](pyconfig.bzl) lists `pyconfig.h` as configure would write it
for x86_64 musl with GCC 13.5, a static interpreter without dynamic module
loading. [sources.bzl](sources.bzl) holds the Makefile's object lists and
the modules of `Modules/Setup.bootstrap.in` and `Setup.stdlib.in` that need
no external library; zlib, bz2, lzma, zstd, dbm, readline, ctypes, curses,
sqlite3, ssl, uuid and tkinter are left out, as are the test modules. [generators/makesetup.awk](generators/makesetup.awk) writes
`Modules/config.c` as `Modules/makesetup` does.

Where configure's result differs from a plain run, a comment in
`pyconfig.bzl` says why: dynamic loading is off, since the interpreter is
static, and the SIMD Blake2 implementations are not built. The Linux UAPI
headers follow musl's in the search path, as in a native `/usr/include`.
musl gives threads 128 KiB of stack. As configure does on musl, the linker
asks for 1 MiB.

## Installation

`:installation` holds `bin/python3` and the standard library under
`lib/python3.14`, without the test suite, the Tk GUI modules and ensurepip.
The interpreter finds its prefix from the library's `os.py` and its exec
prefix from `lib-dynload`, which holds only a note, so it runs from any
directory with no environment. `:python3` runs it from its installation, and
the cellar's Python tests run it with `command_test`.
[generators/sysconfigdata.py](generators/sysconfigdata.py) writes the
`_sysconfigdata` module `sysconfig` and `zoneinfo` read, as `python -m
sysconfig --generate-posix-vars` does, from `pyconfig.h` and the Makefile
variables this build sets.

## Tests

`smoke-test` exercises what the cellar's scripts and CPython's generators
use. `regeneration-test` checks the generated sources, as above.
`regrtest-test` runs CPython's own tests of what `pyconfig.h` decides, 43
files and nearly 8,000 cases, from an installation with the test suite in its
library. BUILD names the cases it leaves out and why: some CPython skips on
musl, but it cannot recognize musl in a static executable; some need the
test modules; one runs a shell. `test_subprocess` is left out whole, since it
needs `/bin/sh`, `cat` and `sleep`, which a remote executor's image lacks.

```
buck2 test cellar//bootstrap/stage1/python:
```
