<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# CPython 3.14

The final GCC 13.5 stage and musl 1.2.5 build CPython 3.14.7 from its
release tarball, as one static executable with every extension module built
in. No configure or Make process runs. The interpreter serves the tests,
tools and build steps that need Python, so they run on a bootstrap executor
instead of the host's `python3`.

## Generated sources

The tarball ships sources that Python scripts generate, among them the PEG
parser, the bytecode interpreter's cases and metadata, the AST, token and
keyword tables, Argument Clinic's argument parsers, the frozen module list,
the global object tables, the standard library's module names, the regular
expression case table, and the CJK codecs' and Unicode database's tables.
The build compiles them as shipped.

`regeneration-test` has the interpreter built from them rerun, in a copy of
the source tree, the generators of `make regen-all`, `make clinic`,
`make regen-limited-abi`, `make regen-stdlib-module-names`,
`make regen-unicodedata` and `make regen-re`, and the CJK mapping
generators, and requires the copy to equal the original.
[regen_data.bzl](regen_data.bzl) pins the data the Unicode and CJK
generators download: the Unicode Character Database 16.0.0, and 3.2.0 for
IDNA, and the East Asian mapping tables on unicode.org. The module names
come from an interpreter run in the tree as from a build directory, with
the Setup files configure would write and the sysconfig data this build
installs.

Some generated files get a weaker check or none. The Levenshtein test
examples are drawn at random, so
[tests/levenshtein.py](tests/levenshtein.py) checks each shipped example
against the generator's own distance function and format instead. The
Big5-HKSCS table's source lies behind the Hong Kong government's
click-through license, so `mappings_hk.h` is compiled as shipped without a
check. Generated files outside those make targets, such as pydoc's topics,
which need Sphinx, and the charmap codecs in `Lib/encodings`, are used as
shipped.

The frozen modules are not shipped. `_freeze_module`, built from everything
but the path configuration and the frozen modules, compiles and marshals
each one, as the Makefile's native build does.

## Configuration

[pyconfig.bzl](pyconfig.bzl) lists `pyconfig.h` as configure would write it
for x86_64 musl with GCC 13.5, a static interpreter without dynamic module
loading. [sources.bzl](sources.bzl) holds the Makefile's object lists, the
modules of `Modules/Setup.bootstrap.in` and `Setup.stdlib.in` that the
bundled libraries and [zlib](../zlib/README.md) serve, and the state
configure records for each module. bz2, lzma, zstd, dbm, readline, ctypes,
curses, sqlite3, ssl, `_hashlib`, uuid and tkinter need libraries the final
GCC stage does not build, and the test modules are left out as
`--disable-test-modules` would. BUILD checks that it builds exactly the
modules whose state is `yes`.
[generators/makesetup.awk](generators/makesetup.awk) writes
`Modules/config.c` as `Modules/makesetup` does.

Where configure's result differs from a plain run, a comment in
`pyconfig.bzl` says why. Dynamic loading is off, since the interpreter is
static, and the SIMD Blake2 implementations are not built. The Linux UAPI
headers follow musl's in the search path, as in a native `/usr/include`.
musl gives threads 128 KiB of stack. As configure does on musl, the linker
asks for 1 MiB.

## Installation

`:installation` holds `bin/python3` and the standard library under
`lib/python3.14`, without the test suite, the Tk GUI modules and ensurepip.
The interpreter finds its prefix from the library's `os.py` and its exec
prefix from `lib-dynload`, which holds only a note, so it runs from any
directory with no environment. `:python3` runs it from its installation
with `PYTHONDONTWRITEBYTECODE` set, so imports write no bytecode into an
installation that is an action's input. Other packages' actions and tests
run `:python3`.
[generators/sysconfigdata.py](generators/sysconfigdata.py) writes the
`_sysconfigdata` module `sysconfig` and `zoneinfo` read, as `python -m
sysconfig --generate-posix-vars` does, from `pyconfig.h` and the Makefile
variables this build sets, with every module's state.

## Tests

`smoke-test` exercises what the cellar's scripts and CPython's generators
use. `regeneration-test` checks the generated sources, as above.
`regrtest-test` runs CPython's own tests of what `pyconfig.h` decides and of
the zlib-based modules, in parallel worker processes as `make test` does.
[tests/regrtest.sh](tests/regrtest.sh) runs them from a writable copy of
`:installation` with the tarball's `Lib/test` added to its library, since
the isolated interpreters tests start ignore `PYTHONDONTWRITEBYTECODE` and
`test_zipfile` compiles modules with `py_compile`, and either would write
bytecode beside the library. BUILD names the cases it leaves out and why.
CPython skips some on musl, but it cannot recognize musl in a static
executable. Some need the test modules, and one runs a shell.
`test_subprocess` is left out whole, since it needs `/bin/sh`, `cat` and
`sleep`, which a remote executor's image lacks.

The regression tests take most of an hour, so `regrtest-test` carries the
`slow` label, which test sweeps leave out. Its run is the test target's own
action, not a separate generator's, so a sweep skips the run as well as the
comparison. Name the target, or pass `--include slow`, to run it:

```
buck2 test cellar//bootstrap/stage1/python:
buck2 test cellar//bootstrap/stage1/python:regrtest-test
```
