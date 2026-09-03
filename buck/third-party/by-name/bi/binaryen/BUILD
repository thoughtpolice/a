# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

VERSION = "132"

# The macOS builds are published under the architecture's other name.
ARCH = "aarch64" if host_info().arch.is_aarch64 else ("x86_64" if host_info().arch.is_x86_64 else "unsupported")

OS = "macos" if host_info().os.is_macos else ("linux" if host_info().os.is_linux else "unsupported")

PLATFORM = ("arm64-macos" if ARCH == "aarch64" else "x86_64-macos") if OS == "macos" else "{}-linux".format(ARCH)

CHECKSUMS = {
    "aarch64-linux": "c58562417836c5d0493d89bdefc434933bdc097db641b483df86bcfa557a107f",
    "arm64-macos": "98aad827847af7ef990ed7098d885725c8e5b5aae75073403635617ae4e259aa",
    "x86_64-linux": "195ddc94f9bc89f45abdabb0b9eea86023d727ba90eac8b35b80f2544fc30572",
    "x86_64-macos": "40c3de90bb3766bd0282a895e139a6f50253dba49b4f5bb89e66faca162d832e",
}

depot.http_archive(
    name = "release",
    sha256 = CHECKSUMS[PLATFORM],
    strip_prefix = "binaryen-version_{}".format(VERSION),
    sub_targets = [
        "bin/wasm-opt",
        "LICENSE",
    ],
    type = "tar.gz",
    urls = ["https://github.com/WebAssembly/binaryen/releases/download/version_{0}/binaryen-version_{0}-{1}.tar.gz".format(VERSION, PLATFORM)],
)

depot.command(
    name = "wasm-opt",
    cmd = ["$(location :release[bin/wasm-opt])"],
    visibility = ["PUBLIC"],
)
