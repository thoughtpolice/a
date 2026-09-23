<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Full-Source Bootstrap project

The [native stage1 bootstrap](stage1/README.md) now delivers static GCC 13.5.0
C/C++, binutils 2.41, musl 1.2.5 and bootstrap userland through
`cellar//bootstrap/stage1:all`. Its source regeneration, fixed-point comparisons,
installation and validation are declared entirely in cellar.

Cellar builds from anywhere in the repository. Inside `cellar/`, its
`.buckroot` makes it a standalone Buck project with its own configuration, no
prelude and no inherited PACKAGE policy. Elsewhere, the parent project builds
the same `cellar//` targets and registers cellar's executor next to its own.
All rules and platform definitions are local either way. Both target and
execution configurations require **x86_64 Linux** throughout the native
bootstrap. The closure audits run from `cellar/`, since only the standalone
project shows that nothing outside cellar is loaded. CI does not build cellar
yet.

```sh
buck2 build @cellar//bootstrap/platforms/sandbox \
  cellar//bootstrap/stage1:all --show-output
```

Package notes that run `../buck/bin/buck2` assume `cellar/` as the working
directory. The Buck binary itself is trusted infrastructure and can live
outside cellar.

The [platform guide](platforms/README.md) describes the cellar-local Linux
executor and remote-only mode for Windows, macOS, and Linux clients. Remote
workers must be x86_64 Linux; a live RBE build still needs an endpoint and
validation. `buck2 run` executes the finished program on the client, so clients
that cannot run Linux ELF programs should use remote `build` and `test`.

The project began as a port of the GNU Guix _Full-Source Bootstrap_ approach.
Its current native compiler sequence follows the pinned live-bootstrap recipes
described in the [stage1 implementation notes](stage1/README.md).

See the Guix blog for more background:
<https://guix.gnu.org/blog/2023/the-full-source-bootstrap-building-from-source-all-the-way-down/>

And the following repositories, where most of this code was cribbed from:

- https://github.com/oriansj/bootstrap-seeds
- https://github.com/oriansj/stage0-posix, commit
  `45d90f5955b6907dc6cdea9ebafce558359edcd3`

Buck2 and the running kernel remain trusted infrastructure. Source regeneration,
compiler fixed points, declared dependency audits, and process/file tracing
provide separate checks of the bootstrap; none removes that trust boundary.

## The full picture

The implemented compiler chain is stage0 → Mes/MesCC → TCC → GCC 4.0.4 →
GCC 4.7.4 → GCC 10.5.0 → GCC 13.5.0 C/C++, with native binutils, musl, and a
useful static userland.
BUILD files describe package composition and source generators directly;
package-wide configure, Make, or kaem scripts do not drive the graph.

Small source adaptations use the M2-built [exact patch helper](stage1/simple-patch/README.md).
Each change has one `.patch` file, or short `before`/`after` strings in BUILD.
The helper requires one exact match and writes a separate output, retaining the
original source tree and avoiding paired fragment files.

A later goal is to reach a modern compiler such as LLVM with as few additional
compiler generations as practical. This is outside the current native endpoint.

In the long run, I think it might be possible to compile clang/lld to wasm,
which we could then use as a way of bootstrapping a compiler/linker on all
modern platforms all the way from hex0. That wasm binary can then be hosted
somewhere and used as a baseline compiler for all platforms to start a full
toolchain bootstrap. We'd have to cross compile from linux to macOS/Windows at
this stage, which is the biggest hang-up, I think. But the goal would be to have
a set of binaries for each main platform that can be built from scratch up-to
bit identical outputs.

## Updating from upstream stage0-posix

All source files under `stage0-posix/` are direct copies from the upstream
stage0-posix repository and its submodules. They must not be hand-edited; they
should only be updated by copying from upstream.

The directory names differ from upstream's submodule names:

| Cellar directory       | Upstream submodule    |
|------------------------|-----------------------|
| `m2-libc/`             | `M2libc/`             |
| `m2-planet/`           | `M2-Planet/`          |
| `m2-mesoplanet/`       | `M2-Mesoplanet/`      |
| `mescc-tools/`         | `mescc-tools/`        |
| `mescc-tools-extra/`   | `mescc-tools-extra/`  |

The `seeds/linux-amd64/` directory contains files from multiple upstream
locations. Most seed files come from the `AMD64/` submodule (with renamed
filenames), while `bootstrap.c` comes from `M2libc/amd64/linux/bootstrap.c`:

| Seed file       | Upstream source                       |
|-----------------|---------------------------------------|
| `bootstrap.c`   | `M2libc/amd64/linux/bootstrap.c`      |
| `cc.M1`         | `AMD64/cc_amd64.M1`                   |
| `defs.M1`       | `AMD64/amd64_defs.M1`                 |
| `libc-core.M1`  | `AMD64/libc-core.M1`                  |
| `ELF.hex2`      | `AMD64/ELF-amd64.hex2`                |
| `hex0.hex0`     | `AMD64/hex0_AMD64.hex0`               |
| `hex1.hex0`     | `AMD64/hex1_AMD64.hex0`               |
| `hex2.hex1`     | `AMD64/hex2_AMD64.hex1`               |
| `catm.hex2`     | `AMD64/catm_AMD64.hex2`               |
| `M0.hex2`       | `AMD64/M0_AMD64.hex2`                 |

A validation script is included to verify all files match upstream:

    ./bootstrap/stage0-posix/check-upstream.sh /path/to/stage0-posix

This checks all 164+ source files and reports any mismatches. Run it after
any update to confirm nothing was missed or accidentally hand-edited.

## Custom tools: `cellar-extra/`

Tools that are NOT from upstream stage0-posix live in `stage0-posix/cellar-extra/`.
They are compiled with the same M2-Mesoplanet toolchain but kept separate so
`check-upstream.sh` can verify the upstream directories are unmodified. Current
tools: `chdirexec`, `chdirenv`, `envexec`, `bytecmp`. Mes sources are assembled from explicit archive projections in
`mes/BUILD`; no host copy utility or preprocessed syntax blob is consumed.

## Boundaries

The current build produces only native x86_64 Linux programs. Other execution
architectures, cross compilation, shared runtimes, multilib, additional GCC
languages, Gold, kernel/OS bootstrapping, and modern GCC/LLVM remain deferred.
Older stage0 architecture source mirrors do not register supported executors.
Historical design alternatives in [CLAUDE_NOTES.md](CLAUDE_NOTES.md) are retained
as research, not instructions for the current build.
