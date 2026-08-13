# Full-Source Bootstrap project

This is an attempt to port the GNU Guix _Full-Source Bootstrap_ project to Buck2
rules. The goal is that one day we might actually emit a fully usable C
compiler, right from the source code, that we can use to compile all third-party
code.

See the Guix blog for more background:
<https://guix.gnu.org/blog/2023/the-full-source-bootstrap-building-from-source-all-the-way-down/>

And the following repositories, where most of this code was cribbed from:

- https://github.com/oriansj/bootstrap-seeds
- https://github.com/oriansj/stage0-posix, commit
  `45d90f5955b6907dc6cdea9ebafce558359edcd3`

Note that because this port uses buck2 itself, it isn't "trustable" in the same
way the `kaem` based build is: buck2 is a foreign contaminant that could in
theory poison the build process. But our goal is more to have a fully hermetic
and "closed world" build.

## The full picture

The first goal is to try and get roughly to where GNU Mes is today for
bootstrapping Guix: an ancient triplet of GNU tools that we can use to start
everything off. Once we have this, we might actually have gone far enough to see
this through.

After that, we need to try and get to a modern baseline compiler as quickly as
possible. Practically this means somehow getting to a modern build of LLVM with
as few intermediate hops as we can.

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

    ./stage0-posix/check-upstream.sh /path/to/stage0-posix

This checks all 164+ source files and reports any mismatches. Run it after
any update to confirm nothing was missed or accidentally hand-edited.

## Custom tools: `cellar-extra/`

Tools that are NOT from upstream stage0-posix live in `stage0-posix/cellar-extra/`.
They are compiled with the same M2-Mesoplanet toolchain but kept separate so
`check-upstream.sh` can verify the upstream directories are unmodified. Current
tools: `chdirexec`, `chdirenv`, `envexec`, `bytecmp`, `prepare-mes-src`.

## TODO

Roughly in the order they need to be accomplished:

- stage0-posix
  - [x] x86_64
  - [ ] aarch64
- [ ] mes + mescc
  - [ ] mescc self-bootstrap
- [ ] tinycc
  - [ ] self-bootstrap
- ancient tools
  - [ ] glibc-2.2.5
  - [ ] binutils-2.20.1
  - [ ] gcc-2.95.3
