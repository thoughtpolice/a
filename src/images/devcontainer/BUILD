# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/images/minimos:defs.bzl", "minimos")
load("@third-party//by-name/wo/wolfi:devcontainer.bzl", "DEVCONTAINER_CLOSURE")

# The devcontainer: a Wolfi userland with the host tools this repository's
# build expects, so a clone builds in it with nothing else installed. See
# README.md.

_TOOLS = "//src/images/devcontainer/tools"

# Read by the resolver and people rather than by a build rule.
depot.lint_files(
    name = "files",
    srcs = [
        "README.md",
        "packages.txt",
    ],
)

_WOLFI = "third-party//by-name/wo/wolfi"

# Wolfi's openssf-compiler-options, which clang and gcc depend on, puts
# distro build flags in clang's default configuration files: -O2,
# -D_FORTIFY_SOURCE=3, -fno-strict-overflow (which hides UBSan's signed
# overflow checks), -march=x86-64-v2 and more. Builds here take their
# flags from buck/toolchains/cxx, so leave the files out, along with the
# per-version links to their directory.
_CLANG_CONFIG = ["etc/clang"] + ["etc/clang-{}".format(v) for v in range(14, 24)]

# clang-23 ships clang's and clang-tidy's libraries as static archives,
# almost 800MB that only a program linking clang into itself would use.
_CLANG_ARCHIVES = [
    "usr/lib/llvm-23/lib/*.a",
    "usr/lib/libclang.a",
]

# wolfi-baselayout 20230201-r30, which BUILD pins, ships /tmp and /var/tmp
# world-writable without the sticky bit.
_CHMOD = [
    "tmp:1777",
    "var/tmp:1777",
]

depot.genrule(
    name = "wolfi-layer",
    out = "wolfi-layer.tar.gz",
    cmd = " ".join(
        [
            "$(exe {}:apk_layer)".format(_TOOLS),
            "--out",
            "$OUT",
        ] + ["--exclude '{}'".format(path) for path in _CLANG_CONFIG + _CLANG_ARCHIVES] +
        ["--chmod " + spec for spec in _CHMOD] +
        ["$(location {}:{}.apk)".format(_WOLFI, package) for package in DEVCONTAINER_CLOSURE],
    ),
)

# Rust from upstream, because the toolchain needs nightly features
# (-Zthreads, -Zsanitizer) and Wolfi packages stable releases only. This
# is the nightly the Nix dev shell runs, with std for every target
# buck/toolchains/rust builds. The hashes come from that date's
# https://static.rust-lang.org/dist/<date>/channel-rust-nightly.toml.
_RUST_DATE = "2026-09-03"

_RUST_COMPONENTS = {
    "cargo-nightly-x86_64-unknown-linux-gnu": "a60615509715996b8d4d54b30a7db8a1cd62400d06206dbeeb20b223ad1e6b34",
    "clippy-nightly-x86_64-unknown-linux-gnu": "9715b53a8e80261f85eeddc6096e82e6038218ddd81e9fd8d7d5d558d076191b",
    "rust-analyzer-nightly-x86_64-unknown-linux-gnu": "a5276dad0411b6213a9e40e855d80b2578b54128a7d6ecc45dc52083b2cdd989",
    "rust-src-nightly": "75af8f1452b9deb6b7a3b1adb4a9cf8d2a2bff316af20aaeb55c67f8767cf1aa",
    "rust-std-nightly-aarch64-unknown-linux-gnu": "3a0e57f9f0251db8d9d2e2f9900e82b5806ab3a9bf4297d5d27ffc361c80d5ed",
    "rust-std-nightly-aarch64-unknown-uefi": "f2bddafb8e6e30ed777399c4c0c8794d7a0bd7c9a64cf3271e79f65966989e32",
    "rust-std-nightly-wasm32-unknown-unknown": "f0e9a90de1fd52435dc1db90519e602a47fce0591ab07e407fed427f7d2940f6",
    "rust-std-nightly-x86_64-unknown-linux-gnu": "7bfd37eda0920b04ef50b4785475c5fa2cea8df19c24f3879d0b5cac6e4dcdbc",
    "rust-std-nightly-x86_64-unknown-uefi": "00d31e369841c53a9c41014aae0c6ab8f260cb4f62b49ac96007215f5a99fc07",
    "rustc-nightly-x86_64-unknown-linux-gnu": "bd1f0986150596835e808635d81786c60ab9da3981687dfb00918329925e837a",
    "rustfmt-nightly-x86_64-unknown-linux-gnu": "78d96443d9d7effe410c46e27b2c103d674ca18fda645e41da7e3408795d8e21",
}

[
    depot.http_file(
        name = component + ".tar.xz",
        sha256 = sha256,
        urls = ["https://static.rust-lang.org/dist/{}/{}.tar.xz".format(_RUST_DATE, component)],
    )
    for component, sha256 in _RUST_COMPONENTS.items()
]

depot.genrule(
    name = "rust-layer",
    out = "rust-layer.tar.gz",
    cmd = " ".join(
        [
            "$(exe {}:rust_layer)".format(_TOOLS),
            "--out",
            "$OUT",
            "--prefix",
            "usr/local",
        ] + ["$(location :{}.tar.xz)".format(component) for component in sorted(_RUST_COMPONENTS)],
    ),
)

# Lean's published build of the release or nightly buck/nix/lean4.nix
# pins, as CI's install-lean action installs it; buck/toolchains/lean
# checks the version. It goes in /opt/lean, less what _LEAN_EXCLUDES
# leaves out, and config/lean.sh puts its tools on PATH.
_LEAN_VERSION = "4.37.0-nightly-2026-10-29"

# The release unpacks to 3.3GB. Most of what goes:
_LEAN_EXCLUDES = [
    # The C toolchain leanc drives: clang, lld, llvm-ar, LLVM's and
    # clang's libraries, clang's headers and a glibc to link against.
    # buck/toolchains/lean asks leanc for its flags only, and compiles
    # and links with buck/toolchains/cxx. leanmake and lean.mk drive it.
    "bin/clang",
    "bin/ld.lld",
    "bin/llvm-ar",
    "bin/leanmake",
    "include/clang",
    "lib/*crt*.o",
    "lib/glibc",
    "lib/libLLVM*",
    "lib/libclang-cpp*",
    "share/lean",
    # Checkers, servers and tools that nothing here runs.
    "bin/beam-daemon",
    "bin/con-leche",
    "bin/con-ron",
    "bin/lean-beam*",
    "bin/lean4lean",
    "bin/leanchecker-paranoid",
    "bin/leanexport",
    "bin/leantar",
    "bin/nanoda_bin",
    # The Lean and Lake libraries' .olean, .ir and .ilean files and
    # sources, 1.6GB, which only `import Lean` and `import Lake` read.
    # Nothing in the repository imports either, and the language server
    # gets its setup from buck/toolchains/lean/lsp/lake rather than Lake.
    # libLean.a, libLake.a and the shared libraries stay, since every
    # Lean program and Lean's own binaries link them.
    "lib/lean/Lake",
    "lib/lean/Lake.*",
    "lib/lean/LakeMain.*",
    "lib/lean/Lean",
    "lib/lean/Lean.*",
    "src/lean/Lean",
    "src/lean/Lean.lean",
    "src/lean/lake",
]

depot.http_file(
    name = "lean.tar.zst",
    sha256 = "4e4a4fa6a64a393773c43df02a84dd2799e605f7e5dba60598680c28f29794f8",
    urls = ["https://github.com/leanprover/lean4-nightly/releases/download/nightly-{}/lean-{}-linux.tar.zst".format(
        _LEAN_VERSION.split("-nightly-")[1],
        _LEAN_VERSION,
    )],
)

depot.genrule(
    name = "lean-layer",
    out = "lean-layer.tar.gz",
    cmd = " ".join(
        [
            "$(exe {}:archive_layer)".format(_TOOLS),
            "--out",
            "$OUT",
            "--prefix",
            "opt/lean",
        ] + ["--exclude '{}'".format(path) for path in _LEAN_EXCLUDES] + [
            "$(location :lean.tar.zst)",
        ],
    ),
)

_LEAN_TOOLS = [
    "lake",
    "lean",
    "leanc",
    "leanchecker",
    "leanir",
]

# DotSlash runs every launcher in buck/bin, buck2 included. The musl
# build is static.
depot.http_archive(
    name = "dotslash",
    sha256 = "4c75c6eb7890ae35993b962073f6d9bbe78b42b81a5691303ad70f63bfbf7196",
    sub_targets = ["dotslash"],
    type = "tar.gz",
    urls = ["https://github.com/facebook/dotslash/releases/download/v0.5.9/dotslash-linux-musl.x86_64.v0.5.9.tar.gz"],
)

# /etc/depot/devcontainer marks the image, for tools such as doctor.py
# that check the host differently inside it.
minimos.overlay(
    name = "overlay-layer",
    dirs = [
        "etc/depot",
        "usr/local/bin",
    ],
    empty_files = ["etc/depot/devcontainer"],
    files = {
        "etc/buckconfig": "config/buckconfig",
        "usr/local/bin/buck2": "config/launcher.sh:755",
        "usr/local/bin/docker": "config/podman.sh:755",
        "usr/local/bin/dotslash": ":dotslash[dotslash]:755",
        "usr/local/bin/jj": "config/launcher.sh:755",
        "usr/local/bin/podman": "config/podman.sh:755",
    } | {
        "usr/local/bin/" + tool: "config/lean.sh:755"
        for tool in _LEAN_TOOLS
    },
    # UTC, as on Debian's and Ubuntu's images.
    symlinks = {"etc/localtime": "../usr/share/zoneinfo/UTC"},
)

_LAYERS = [
    ":wolfi-layer",
    ":rust-layer",
    ":lean-layer",
    ":overlay-layer",
]

_ENV = {
    "PATH": "/usr/local/bin:/usr/bin",
    "LANG": "C.UTF-8",
}

_LABELS = {
    "org.opencontainers.image.title": "devcontainer",
    "org.opencontainers.image.description": "Wolfi with the host tools the Buck2 build in thoughtpolice/a expects",
    "org.opencontainers.image.source": "https://github.com/thoughtpolice/a",
    "org.opencontainers.image.licenses": "Apache-2.0",
}

depot.genrule(
    name = "devcontainer",
    out = ".",
    cmd = " ".join(
        [
            "$(exe //src/images/minimos/tools:scratch_image)",
            "build",
            "--output",
            "$OUT",
            "--cmd",
            "/bin/bash",
            "--user",
            "root",
            "--arch",
            "amd64",
            "--os",
            "linux",
        ] + ["--layer $(location {})".format(layer) for layer in _LAYERS] +
        ["--env '{}={}'".format(key, value) for key, value in _ENV.items()] +
        ["--label '{}={}'".format(key, value) for key, value in _LABELS.items()],
    ),
    visibility = ["PUBLIC"],
)

depot.oci.archive(
    name = "devcontainer-docker",
    out = "devcontainer.tar",
    image = ":devcontainer",
    image_name = "devcontainer",
)

# CI publishes with `-- --tag <tag>`; a destination such as
# ttl.sh/$USER-devcontainer:1h pushes anywhere else.
depot.oci.push(
    name = "devcontainer-push",
    image = ":devcontainer",
    repository = "ghcr.io/thoughtpolice/a/devcontainer",
)

depot.command(
    name = "smoke-runner",
    cmd = [
        "bash",
        "$(location :smoke.sh)",
    ],
)

depot.export_file(
    name = "smoke.sh",
    src = "smoke.sh",
    mode = "reference",
)

# A dynamic test, so a host without docker reports SKIP rather than
# failing; `buck2 run` on it fails instead.
depot.dynamic_test(
    name = "smoke",
    args = [
        "$(exe root//buck/tools/oci:oci)",
        "$(location :devcontainer)",
        "$(location :smoke-inside.sh)",
    ],
    dep = ":smoke-runner",
)

depot.export_file(
    name = "smoke-inside.sh",
    src = "smoke-inside.sh",
    mode = "reference",
)
