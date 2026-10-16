<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Full-source bootstrap

This project builds a native x86_64 Linux toolchain from source, starting from
a 229-byte `hex0` seed. The chain ends with M2-Planet, M2-Mesoplanet, the
mescc-tools and mescc-tools-extra, all static x86_64 programs.

It follows the approach of GNU Guix's [full-source bootstrap][guix]. BUILD
files declare every action: each assembly, compilation and link. No kaem script
drives the build.

[guix]: https://guix.gnu.org/blog/2023/the-full-source-bootstrap-building-from-source-all-the-way-down/

## Building and testing

Build and test from anywhere in the repository:

```sh
buck2 build -j8 cellar//bootstrap/...
buck2 test -j8 cellar//bootstrap/...
```

Every target and action is x86_64 Linux, on the repository's own
`root//buck/platforms:x86_64-linux` platform. An x86_64 Linux client runs the
actions itself. Any other client, such as an arm64 Linux one, needs remote
execution: `@mode//buildbuddy` runs them on BuildBuddy's x86_64 Linux workers,
in an image with no shell or tools, and `docs/buck2.md` describes how Buck picks
those workers. `buck2 run` runs its program on the client, so it needs an
x86_64 Linux client.

To check that no local action reads anything from the host, run them under
Buck's Landlock sandbox, letting them read only their inputs and `/proc/self`:

```sh
buck2 test -j8 @mode//sandbox -c buck2.local_sandbox_read_paths=/proc/self \
  cellar//bootstrap/...
```

## The chain

Each stage builds the next one from source.

| Stage | Builds | With | Checks |
|---|---|---|---|
| [stage0](stage0-posix/) | hex0 to M2-Planet, M2-Mesoplanet, the mescc-tools and mescc-tools-extra | the hex0 seed | upstream's SHA256 answers |

## Trust boundary

The bootstrap trusts Buck2, the running kernel and the hex0 seed. An earlier
step built every other program that a build action runs, from sources in this
tree. Actions run with an empty environment, and in the sandbox above they
read only their declared inputs and `/proc/self`.

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

- `bytecmp` compares two files byte for byte.
- `chdirenv` runs a command in a directory it creates, keeping the environment.
- `chdirexec` runs a command in a directory with an empty environment.
- `envexec` runs a command with only the given environment variables.
