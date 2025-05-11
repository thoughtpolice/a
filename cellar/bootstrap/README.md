# Full-Source Bootstrap project

This is an attempt to port the GNU Guix _Full-Source Bootstrap_ project to
Buck2 rules. The goal is that one day we might actually emit a fully usable C
compiler, right from the source code, that we can use to compile all third-party
code.

See the Guix blog for more background: <https://guix.gnu.org/blog/2023/the-full-source-bootstrap-building-from-source-all-the-way-down/>

And the following repositories, where most of this code was cribbed from:

- https://github.com/oriansj/bootstrap-seeds
- https://github.com/oriansj/stage0-posix, commit `779e5424d4b55fe9b7faea2285ae8b6486df0433`

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
