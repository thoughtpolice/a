# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

VERSION = "0.57.1"

ARCH = "aarch64" if host_info().arch.is_aarch64 else ("x86_64" if host_info().arch.is_x86_64 else "unsupported")

OS = "macos" if host_info().os.is_macos else ("linux" if host_info().os.is_linux else "unsupported")

PLATFORM = "{}-{}".format(ARCH, OS)

CHECKSUMS = {
    "aarch64-linux": "832a48f8c17826c75977963732e66959e3cda2fffe59d03c32d7a943f1b694ff",
    "aarch64-macos": "41853d25bbbcea84ae2e7f374f8e691d4225c7ca8b0db7b8e94d95ce3259174e",
    "x86_64-linux": "ff95b2daf40fe4e83f30ebc7e12e919c9a96440f32bb87d4915e8ae5e98af2f3",
    "x86_64-macos": "12522a63daf1067d481c41bd7e4c964e799db4ff17b264eed663e4e443b92b98",
}

depot.http_archive(
    name = "release",
    sha256 = CHECKSUMS[PLATFORM],
    strip_prefix = "wit-bindgen-{}-{}".format(VERSION, PLATFORM),
    sub_targets = [
        "wit-bindgen",
        "LICENSE-APACHE",
        "LICENSE-Apache-2.0_WITH_LLVM-exception",
        "LICENSE-MIT",
    ],
    type = "tar.gz",
    urls = ["https://github.com/bytecodealliance/wit-bindgen/releases/download/v{0}/wit-bindgen-{0}-{1}.tar.gz".format(VERSION, PLATFORM)],
)

depot.command(
    name = "wit-bindgen",
    cmd = ["$(location :release[wit-bindgen])"],
    visibility = ["PUBLIC"],
)
