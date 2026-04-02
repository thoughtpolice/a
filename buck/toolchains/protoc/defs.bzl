# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

def protoc_env():
    """Returns an env dict with PROTOC and PROTOC_INCLUDE for use in genrules."""
    return {
        'PROTOC': select({
            'config//cpu:arm64': select({
                'config//os:linux': '$(location toolchains//protoc:protoc-bin-vendored.tar.gz[protoc-bin-vendored-linux-aarch_64/bin/protoc])',
                'config//os:macos': '$(location toolchains//protoc:protoc-bin-vendored.tar.gz[protoc-bin-vendored-macos-x86_64/bin/protoc])',
            }),
            'config//cpu:x86_64': select({
                'config//os:linux': '$(location toolchains//protoc:protoc-bin-vendored.tar.gz[protoc-bin-vendored-linux-x86_64/bin/protoc])',
                'config//os:windows': '$(location toolchains//protoc:protoc-bin-vendored.tar.gz[protoc-bin-vendored-win32/bin/protoc.exe])',
            }),
        }),
        'PROTOC_INCLUDE': select({
            'config//cpu:arm64': select({
                'config//os:linux': '$(location toolchains//protoc:protoc-bin-vendored.tar.gz[protoc-bin-vendored-linux-aarch_64/include])',
                'config//os:macos': '$(location toolchains//protoc:protoc-bin-vendored.tar.gz[protoc-bin-vendored-macos-x86_64/include])',
            }),
            'config//cpu:x86_64': select({
                'config//os:linux': '$(location toolchains//protoc:protoc-bin-vendored.tar.gz[protoc-bin-vendored-linux-x86_64/include])',
                'config//os:windows': '$(location toolchains//protoc:protoc-bin-vendored.tar.gz[protoc-bin-vendored-win32/include])',
            }),
        }),
    }
