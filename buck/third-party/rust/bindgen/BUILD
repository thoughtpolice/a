# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//:export_exe.bzl", "export_exe")

VERSION = '0.69.4'

[
    http_archive(
        name = f'{name}.tar.xz',
        sha256 = sha256,
        urls = [ f'https://github.com/rust-lang/rust-bindgen/releases/download/v{VERSION}/{name}.tar.xz', ],
        type = 'tar.xz',
        strip_prefix = name,
        sub_targets = [ binary ],
        visibility = [],
    ) for name, sha256, binary in [
        ('bindgen-cli-aarch64-apple-darwin', '46b99211e1e8102b0df6ba1dcff9de9e1ac43a895ba77f023feed6ef4fbd5e6e', 'bindgen'),
        ('bindgen-cli-x86_64-unknown-linux-gnu', '3ede28f4f5e66d3a62d9337e0f485650915ac2c2df75cca69debf04413ad28d0', 'bindgen'),
    ]
]

[
    http_archive(
        name = f'{name}.tar.gz',
        sha256 = sha256,
        urls = [ f'https://github.com/cargo-bins/cargo-quickinstall/releases/download/bindgen-cli-{VERSION}/bindgen-cli-{VERSION}-x86_64-pc-windows-msvc.tar.gz' ],
        type = 'tar.gz',
        sub_targets = [ binary ],
        visibility = [],
    ) for name, sha256, binary in [
        ('bindgen-cli-x86_64-pc-windows-msvc', '3416fcd40adaa08e8fc3fbf2d40160fa4db03d6e70bd330df18c33456e2b418c', 'bindgen.exe'),
    ]
]

export_exe(
    name = 'bindgen',
    src = select({
        'config//cpu:x86_64': select({
            'config//os:linux': ':bindgen-cli-x86_64-unknown-linux-gnu.tar.xz[bindgen]',
            'config//os:windows': ':bindgen-cli-x86_64-pc-windows-msvc.tar.gz[bindgen.exe]',
        }),
        'config//cpu:arm64': select({
            'config//os:macos': ':bindgen-cli-aarch64-apple-darwin.tar.xz[bindgen]',
        }),
    }),
    visibility = ['PUBLIC'],
)
