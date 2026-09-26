<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Full-source bootstrap

This project builds a native x86_64 Linux toolchain from source, starting from
a 229-byte `hex0` seed. The chain ends with GCC 13.5 and binutils 2.41, a
userland of GNU tools, CPython 3.14.7 and an LLVM 23.1 toolchain that built
itself, all static x86_64 programs linked against musl.

It follows the approach of GNU Guix's [full-source bootstrap][guix] and the
recipes of [live-bootstrap] at `dd8ac27bf959344b9bcf5e876bdd7716879bbc70`.
BUILD files declare every action: each source, generator, compiler invocation,
archive and link. No configure script, Makefile or kaem script drives the
build.

[guix]: https://guix.gnu.org/blog/2023/the-full-source-bootstrap-building-from-source-all-the-way-down/
[live-bootstrap]: https://github.com/fosslinux/live-bootstrap

## Building and testing

`cellar/` is a Buck project of its own, with its own configuration and
platforms and no prelude. The parent repository builds the same `cellar//`
targets as well. From `cellar/`:

```sh
../buck/bin/buck2 build @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage1:all cellar//bootstrap/stage1/llvm:toolchain \
  --show-output
../buck/bin/buck2 test @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/...
```

`stage1:all` installs GCC 13.5, binutils 2.41, musl 1.2.5 and the userland;
`stage1/llvm:toolchain` installs Clang, LLD and their runtimes. A cold build of
everything takes hours on one machine. The `sandbox` mode runs every action
under Buck's Landlock sandbox with cellar's path lists. From the parent
project, `@mode//buildbuddy` builds on BuildBuddy instead. The
[platform guide](platforms/README.md) describes local, sandboxed and remote
execution.

Target and execution platforms are always x86_64 Linux. `buck2 run` runs its
program on the client, so it needs an x86_64 Linux client.

## The chain

Each stage builds the next one from source. The
[stage1 overview](stage1/README.md) describes each stage and its checks.

| Stage | Builds | With | Checks |
|---|---|---|---|
| [stage0](stage0-posix/) | hex0 to M2-Planet, M2-Mesoplanet, the mescc-tools and mescc-tools-extra | the hex0 seed | upstream's SHA256 answers |
| [Mes](mes/) | Mes 0.27 and MesCC, [NYACC](nyacc/) tables | M2-Planet | two Mes generations match |
| [TCC](stage1/tcc/README.md) | TCC 0.9.26, then [TCC 0.9.27](stage1/tcc-release/README.md) | MesCC, Mes libc | two TCC 0.9.26 generations match |
| [musl 1.1.24](stage1/musl/README.md) | [sed](stage1/sed/README.md), musl with [regenerated tables](stage1/musl-tables/README.md), [TCC against musl](stage1/tcc-musl/README.md) | TCC | tables match the release |
| Parser tools | [oyacc](stage1/oyacc/README.md), [Bash 2.05b](stage1/bash-bootstrap/README.md), [lex](stage1/heirloom-lex/README.md), [Flex](stage1/flex/README.md), [Bison](stage1/bison/README.md), [m4](stage1/m4/README.md), [gawk](stage1/gawk/README.md) | TCC, musl 1.1.24 | Flex and Bison regenerate themselves |
| [binutils 2.30](stage1/binutils/README.md) | as, ld, ar and the rest, [GNU cat and rm](stage1/coreutils/README.md) | TCC, musl 1.1.24 | BFD headers and x86 tables match the release |
| [TCC with GNU binutils](stage1/tcc-native/README.md) | musl 1.1.24 and TCC 0.9.27 again | TCC, binutils 2.30 | exact floating constants |
| [GCC 4.0.4](stage1/gcc40/README.md) | GCC 4.0.4 C compiler | TCC, binutils 2.30 | `ucnid.h` matches the release |
| [musl 1.2.5](stage1/musl12/README.md) | musl 1.2.5, [GCC 4.0.4 again](stage1/gcc40-rebuilt/README.md) | GCC 4.0.4 | tables match the release |
| [GCC 4.7.4](stage1/gcc47/README.md) | [GMP](stage1/gmp/README.md), [MPFR](stage1/mpfr/README.md), [MPC](stage1/mpc/README.md), [tar](stage1/tar/README.md), GCC 4.7.4 C/C++ | GCC 4.0.4, musl 1.2.5 | stage 2 and 3 objects match |
| Userland | Bash 5.2, Make 4.2, coreutils and other GNU tools | GCC 4.7.4 | [sha256sum](stage1/sha256/README.md) across GCC generations |
| [GCC 10.5](stage1/gcc10/README.md) | GCC 10.5.0 C/C++, [pax](stage1/pax/README.md) | GCC 4.7.4 | stage 2 and 3 objects match |
| [binutils 2.41](stage1/binutils241/README.md) | as, ld, ar and the rest | GCC 10.5 | regenerated tables match the release |
| [GCC 13.5](stage1/gcc13/README.md) | [mimalloc](stage1/mimalloc/README.md), GCC 13.5.0 C/C++ | GCC 10.5, binutils 2.41 | stage 2 and 3 objects match |
| [Installation](stage1/installation/README.md) | relocatable toolchain and userland trees | GCC 13.5 | programs build and run from the installation alone |
| [CPython](stage1/python/README.md) | [Linux headers](stage1/linux-headers/README.md), [zlib 1.3.2](stage1/zlib/README.md), CPython 3.14.7 | GCC 13.5, musl 1.2.5 | generated sources match the release |
| [LLVM](stage1/llvm/README.md) | Clang, LLD, llvm-ar 23.1, then musl and runtimes | GCC 13.5, then Clang | stage 2 and 3 match |

## Trust boundary

The bootstrap trusts Buck2, the running kernel and the hex0 seed. An earlier
stage built every other program that a build action runs, from source, and a
SHA256 hash pins every source archive. Actions run with an empty environment,
and in the `sandbox` mode they read only their declared inputs and
`/proc/self`. Only tests run host programs. The platform configuration test
runs the client's `python3` and `buck2`, and some GCC driver tests put the
host's `/usr/bin` on `PATH` to check that GCC ignores it.

Source regeneration and the fixed-point comparisons check the chain from inside
the build. These scripts check it from outside:

- `audit.bxl` walks a target's configured closure and fails if any rule,
  dependency, load or action owner lies outside cellar, or if any target is not
  configured for x86_64 Linux. Run it from `cellar/`, where the standalone
  project cannot load anything outside cellar:

  ```sh
  ../buck/bin/buck2 bxl cellar//bootstrap/audit.bxl:closure -- \
    --target cellar//bootstrap/stage1:all
  ```

- `audit-loads.py` checks that every explicit load in cellar names a cellar
  file.

- `audit-trace.py` reads an `strace` of a build and fails if a bootstrap
  process opened or ran anything outside cellar's sources, outputs and scratch
  directories. Trace an uncached build in its own daemon, and stop that daemon
  from another terminal once it finishes, so that `strace` exits:

  ```sh
  strace --seccomp-bpf -ff -ttt -s 65535 -yy \
    -e trace=%file,%process -o /tmp/trace \
    ../buck/bin/buck2 --isolation-dir trace test \
    @cellar//bootstrap/platforms/sandbox cellar//bootstrap/mes: \
    --local-only --no-remote-cache
  ../buck/bin/buck2 --isolation-dir trace kill
  python3 bootstrap/audit-trace.py --workspace "$PWD" --trace-prefix /tmp/trace
  ```

- `audit-gcc-comparison.py` checks that a GCC port's stage comparisons cover
  every object it builds.

- `audit-installation.py` checks that an installation holds only static
  executables, no symlinks and no workspace paths, and can compare two
  installations built in different workspaces.

None of these removes the trust in Buck and the kernel.

## Updating stage0-posix

The C, M1, hex and answer files under `stage0-posix/`, outside `cellar-extra/`,
are copies from the upstream
[stage0-posix](https://github.com/oriansj/stage0-posix) repository at
`45d90f5955b6907dc6cdea9ebafce558359edcd3` and its submodules, and the
`hex0-seed` binaries come from
[bootstrap-seeds](https://github.com/oriansj/bootstrap-seeds). Never edit them
by hand; copy new versions from upstream. The directory names differ from
upstream's submodule names:

| Cellar directory       | Upstream submodule    |
|------------------------|-----------------------|
| `m2-libc/`             | `M2libc/`             |
| `m2-planet/`           | `M2-Planet/`          |
| `m2-mesoplanet/`       | `M2-Mesoplanet/`      |
| `mescc-tools/`         | `mescc-tools/`        |
| `mescc-tools-extra/`   | `mescc-tools-extra/`  |

`seeds/linux-amd64/` gathers files from the `AMD64/` submodule under shorter
names, plus `bootstrap.c` from `M2libc`. `m2-libc/` keeps every architecture's
files, because M2-Mesoplanet opens every file an `#include` names, including
those behind another architecture's `#if`. After an update, compare every copy
with the upstream checkout:

```sh
bootstrap/stage0-posix/check-upstream.sh /path/to/stage0-posix
```

The script's comments give each seed file's upstream name. It fails on any file
that is missing upstream or differs from it.

Cellar's own helpers live in `stage0-posix/cellar-extra/`, which the script
does not check. M2-Mesoplanet builds them like mescc-tools-extra:

- `answer-test` lists stage0's answers file and checks one entry of it for the
  answer test.
- `bytecmp` compares two files byte for byte.
- `chdirenv` runs a command in a directory it creates, keeping the environment.
- `chdirexec` runs a command in a directory with an empty environment.
- `envexec` runs a command with only the given environment variables.
