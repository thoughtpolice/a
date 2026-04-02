# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

shims.http_archive(
    name = 'protoc-bin-vendored.tar.gz',
    sha256 = '08f5cc8f522af7ba8f9f1a81f93bba94cef9312e5e644df4ecc08ea7ce9c40f7',
    urls = [
        'https://github.com/stepancheg/rust-protoc-bin-vendored/archive/20ebfb74aad5fb0f084ca2c2ebc0885b4ad18430.tar.gz',
    ],
    type = 'tar.gz',
    strip_prefix = 'rust-protoc-bin-vendored-20ebfb74aad5fb0f084ca2c2ebc0885b4ad18430',
    sub_targets = [
        'protoc-bin-vendored-linux-aarch_64/bin/protoc',
        'protoc-bin-vendored-linux-aarch_64/include',
        'protoc-bin-vendored-linux-x86_64/bin/protoc',
        'protoc-bin-vendored-linux-x86_64/include',
        'protoc-bin-vendored-macos-x86_64/bin/protoc',
        'protoc-bin-vendored-macos-x86_64/include',
        'protoc-bin-vendored-win32/bin/protoc.exe',
        'protoc-bin-vendored-win32/include',
    ],
)
