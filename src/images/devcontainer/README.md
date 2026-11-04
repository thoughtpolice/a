<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# devcontainer

An OCI image with the host tools this repository's Buck2 build expects,
so that any machine or CI provider with a container runtime can pull it,
clone the repository, and build. It has nothing to do with the VS Code
devcontainer spec. "devcontainer" is just its name.

```
docker run --rm -it ghcr.io/thoughtpolice/a/devcontainer:canon
git clone https://github.com/thoughtpolice/a && cd a
buck2 build //src/...
```

`buck2` and `jj` in `/usr/local/bin` run the DotSlash launcher of the same
name from the checkout around the working directory, so nothing needs
`buck/bin` on PATH. The image runs as root and has no package manager.
Changing it means changing this package and rebuilding.

## What's in it

Everything except Rust, Lean and DotSlash comes from pinned
[Wolfi](https://wolfi.dev) packages. `packages.txt` lists the roots, and
`third-party//by-name/wo/wolfi:resolve` turns them into the full closure
in `buck/third-party/by-name/wo/wolfi/devcontainer.bzl`, with a version
and sha256 for every package. The Wolfi package's BUILD loads that file,
so the devcontainer's packages get the same osv.dev advisory checks as
the minimos pins. The image contains:

- a GNU userland, bash, and dash as `/bin/sh`, plus git, curl, jq,
  OpenSSH's client and Python 3.13 for `check.py` and `doctor.py`.
- clang, lld, the LLVM binutils and compiler-rt 23 for
  `buck/toolchains/cxx`, with GCC 16 for libstdc++, GNU binutils for
  `ar` and friends, and mold for linking.
- bindgen 0.72.1, the version `third-party//by-name/bo/boringssl` checks.
- the same Rust nightly as the Nix dev shell, from static.rust-lang.org,
  in `/usr/local`, with std for x86_64 and aarch64 Linux, both UEFI
  targets, and wasm32. Wolfi only packages stable Rust, and the toolchain
  needs `-Zthreads` and `-Zsanitizer`.
- Lean's published build of the release or nightly `buck/nix/lean4.nix`
  pins, in `/opt/lean`. `lake`, `lean`, `leanc`, `leanchecker` and
  `leanir` in `/usr/local/bin` run it. It leaves out the C toolchain the
  release bundles, since `buck/toolchains/lean` compiles with the
  image's, and the Lean and Lake libraries' modules, so `import Lean` and
  `import Lake` don't work in the image. BUILD lists what goes.
- Erlang/OTP 28 for `buck/toolchains/erlang`.
- ICU, which the .NET SDK that `buck/toolchains/csharp` downloads loads
  from the host.
- Podman, as both `podman` and `docker`, for the tests that run
  containers. See [Running containers](#running-containers).
- DotSlash, from its static musl release.

Go, Python, Deno and protoc need nothing here, since the build downloads
them.

## Differences from Wolfi's defaults

- Wolfi's `openssf-compiler-options` writes distro build flags into
  clang's default configuration files, including `-O2`,
  `-D_FORTIFY_SOURCE=3` and `-fno-strict-overflow`, which hides UBSan's
  signed overflow checks. The image leaves those files out, so clang only
  uses the flags the toolchain passes. The smoke test checks this.
- clang-23 ships about 800MB of clang and clang-tidy static archives that
  nothing here links. The image leaves them out too.
- Wolfi has no watchman, so `/etc/buckconfig`, which Buck2 reads for
  every project on the machine, selects `fs_hash_crawler`, as CI does.
  The repository's own configuration and a `.buckconfig.local` still
  override it.

## Running containers

The minimos boot smokes and this image's own smoke test load an image and
run it with `docker`. In the image, `docker` and `podman` both run Podman
as root. That works when the image itself runs with `--privileged`:

```
docker run --rm -it --privileged ghcr.io/thoughtpolice/a/devcontainer:canon
```

Without it, the tests report SKIP, as on a host without docker.

Podman needs to delegate cgroup controllers to the containers it makes,
and cgroup v2 allows that only from a cgroup with no processes in it.
The outer container's processes all start in the root of its cgroup
namespace, so the first `podman` or `docker` call moves them into a child
cgroup, `init`, as Docker-in-Docker does. `config/podman.sh` does this.
The kernel won't stack Podman's overlay mounts on the outer container's
overlay root, so Podman uses fuse-overlayfs for its storage, which it
picks on its own. Mounting a volume at `/var/lib/containers` gives it a
plain filesystem, where it uses the kernel's overlayfs instead.

## Building and testing

```
buck2 build //src/images/devcontainer               # the OCI layout
buck2 build //src/images/devcontainer:devcontainer-docker   # for docker load
buck2 test //src/images/devcontainer:smoke
```

The smoke test loads the image into docker and runs `smoke-inside.sh` in
a container with no network. That script compiles and links C, C++ and
Rust the way the toolchains do, builds Rust for every std target, runs
bindgen against libclang, and compiles and runs Lean and Erlang programs.
Without a docker it can reach, the test reports SKIP. `buck2 run` on it
fails instead.

The image builds from four layers. `tools/apk_layer.py` streams the Wolfi
packages into one, `tools/rust_layer.py` installs Rust's component
tarballs into another, `tools/archive_layer.py` unpacks Lean's release
tarball into a third, and `minimos.overlay` writes the config and
wrappers. minimos's `scratch_image` assembles them. The layer tools are
deterministic and need no root, docker or apk-tools.

## Publishing

`.github/workflows/devcontainer.yml` tests the image on every change to
it and, on canon, pushes it as `ghcr.io/thoughtpolice/a/devcontainer`
with the tags `sha-<commit>` and `canon`. To push anywhere else:

```
buck2 run //src/images/devcontainer:devcontainer-push -- ttl.sh/$USER-devcontainer:1h
```

## Updating

To add or remove a package, edit `packages.txt` and rerun the resolver
from the repository root:

```
buck2 run third-party//by-name/wo/wolfi:resolve -- \
    --roots src/images/devcontainer/packages.txt \
    --name DEVCONTAINER \
    --out buck/third-party/by-name/wo/wolfi/devcontainer.bzl
```

Packages that the Wolfi BUILD file already pins for minimos stay at those
versions, so every Wolfi package has one version in the repository. To
move everything forward, run `buck2 run third-party//by-name/wo/wolfi:update`
first and then the resolver.

To move Rust, change `_RUST_DATE` in BUILD and copy each component's
`xz_hash` from that date's `channel-rust-nightly.toml`. When
`buck/nix/lean4.nix` moves Lean, change `_LEAN_VERSION` and the sha256 of
the `lean.tar.zst` download in BUILD to match. `buck/toolchains/lean`
fails on a Lean of the wrong version.

## Not done yet

- linux/amd64 only. The Wolfi pins are x86_64 only, like minimos's.
- CI's own jobs don't run in the image yet. That's the next step toward
  needing nothing from a provider but a container runtime.
