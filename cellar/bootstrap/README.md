<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Full-source bootstrap

This project builds a native x86_64 Linux toolchain from source, starting from
a 229-byte `hex0` seed. The chain ends with Mes 0.27, a static x86_64 program
linked against its own C library, and Mes's C compiler, MesCC.

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
  cellar//bootstrap/...
../buck/bin/buck2 test @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/...
```

The `sandbox` mode runs every action under Buck's Landlock sandbox with
cellar's path lists. From the parent project, `@mode//buildbuddy` builds on
BuildBuddy instead. The [platform guide](platforms/README.md) describes local,
sandboxed and remote execution.

Target and execution platforms are always x86_64 Linux. `buck2 run` runs its
program on the client, so it needs an x86_64 Linux client.

## The chain

Each stage builds the next one from source. The
[stage1 overview](stage1/README.md) describes each stage and its checks.

| Stage | Builds | With | Checks |
|---|---|---|---|
| [stage0](stage0-posix/) | hex0 to M2-Planet, M2-Mesoplanet, the mescc-tools and mescc-tools-extra | the hex0 seed | upstream's SHA256 answers |
| [Mes](mes/) | Mes 0.27 and MesCC, [NYACC](nyacc/) tables | M2-Planet | two Mes generations match |

## Trust boundary

The bootstrap trusts Buck2, the running kernel and the hex0 seed. An earlier
stage built every other program that a build action runs, from source, and a
SHA256 hash pins every source archive. Actions run with an empty environment,
and in the `sandbox` mode they read only their declared inputs and
`/proc/self`. Only the platform configuration test runs host programs, the
client's `python3` and `buck2`.

Source regeneration and the fixed-point comparisons check the chain from inside
the build. These scripts check it from outside:

- `audit.bxl` walks a target's configured closure and fails if any rule,
  dependency, load or action owner lies outside cellar, or if any target is not
  configured for x86_64 Linux. Run it from `cellar/`, where the standalone
  project cannot load anything outside cellar:

  ```sh
  ../buck/bin/buck2 bxl cellar//bootstrap/audit.bxl:closure -- \
    --target cellar//bootstrap/mes:mescc
  ```

- `audit-loads.py` checks that every explicit load in cellar names a cellar
  file.

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
