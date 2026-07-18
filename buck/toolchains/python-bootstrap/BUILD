# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(
    ":defs.bzl",
    "simple_exe_download",
    "standalone_python_bootstrap_toolchain",
    "standalone_python_download",
)

PYTHON_VERSION_TAG = "20250106"

PYTHON_VERSION = "3.13.1+{PYTHON_VERSION_TAG}".format(PYTHON_VERSION_TAG = PYTHON_VERSION_TAG)

standalone_python_bootstrap_toolchain(
    name = "python_bootstrap",
    interpreter = shims.select({
        "config//cpu:arm64": shims.select({
            "config//os:linux": "$(location :cpython-{PYTHON_VERSION}-aarch64-unknown-linux-gnu.tar.gz[python/bin/python])".format(PYTHON_VERSION = PYTHON_VERSION),
            "config//os:macos": "$(location :cpython-{PYTHON_VERSION}-aarch64-apple-darwin.tar.gz[python/bin/python])".format(PYTHON_VERSION = PYTHON_VERSION),
        }),
        "config//cpu:x86_64": shims.select({
            "config//os:linux": "$(location :cpython-{PYTHON_VERSION}-x86_64-unknown-linux-gnu.tar.gz[python/bin/python])".format(PYTHON_VERSION = PYTHON_VERSION),
            "config//os:windows": "$(location :cpython-{PYTHON_VERSION}-x86_64-pc-windows-msvc.tar.gz[python/python.exe])".format(PYTHON_VERSION = PYTHON_VERSION),
        }),
    }),
)

[
    standalone_python_download(
        name = "cpython-{PYTHON_VERSION}-{name}.tar.gz".format(
            name = name,
            PYTHON_VERSION = PYTHON_VERSION,
        ),
        exe = bin,
        sha256 = sha256,
        smoltar = shims.select({
            "config//cpu:arm64": shims.select({
                "config//os:linux": ":smoltar-aarch64-unknown-linux-musl",
                "config//os:macos": ":smoltar-aarch64-apple-darwin",
            }),
            "config//cpu:x86_64": shims.select({
                "config//os:linux": ":smoltar-x86_64-unknown-linux-musl",
                "config//os:windows": ":smoltar-x86_64-pc-windows-msvc.exe",
            }),
        }),
        url = "https://github.com/astral-sh/python-build-standalone/releases/download/{PYTHON_VERSION_TAG}/cpython-{PYTHON_VERSION}-{name}-install_only.tar.gz".format(
            name = name,
            PYTHON_VERSION = PYTHON_VERSION,
            PYTHON_VERSION_TAG = PYTHON_VERSION_TAG,
        ),
        visibility = [],
    )
    for name, sha256, bin in [
        ("aarch64-unknown-linux-gnu", "d37aef7bdf5c27f7d006918f7cedb31f4ba07c88f61baac4ffbe0bee6d4b5248", "python/bin/python"),
        ("aarch64-apple-darwin", "bbfc96038d0b6922fd783f6eb2c9bf9abb648531d23d236bc1a0c16bdd061944", "python/bin/python"),
        ("x86_64-unknown-linux-gnu", "bb4696825039a2b5dc7fea2c6aeb085c89fd397016b44165ec73b4224ccc83e2", "python/bin/python"),
        ("x86_64-pc-windows-msvc", "e1f151612939a80ad0320244c3d404934e5e99e04d6fa382a8cd5606386b9a11", "python/python.exe"),
    ]
]

[
    simple_exe_download(
        name = name,
        sha256 = sha256,
        url = "https://github.com/thoughtpolice/smoltar/releases/download/v0/{name}".format(name = name),
    )
    for name, sha256 in [
        ("smoltar-aarch64-apple-darwin", "d8964e7bdc8516130012302ea06d18cb130cee13e85145446f8ae473679fc7d4"),
        ("smoltar-aarch64-unknown-linux-musl", "e1a0e2e4b102823c56fa96323d88fdef499ae855dca657d03582558cf48fc65f"),
        ("smoltar-x86_64-unknown-linux-musl", "3f727c5ada7a038f7e60afd003181779440fc11907cfece8a59c6be435ad3e67"),
        ("smoltar-x86_64-pc-windows-msvc.exe", "9b4ea3d1f3414574f16c23c2434d26e4f3cf67804db9d07d50ef3a00d7963184"),
    ]
]
