# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(
    ":defs.bzl",
    "simple_exe_download",
    "standalone_python_bootstrap_toolchain",
    "standalone_python_download",
    "standalone_python_runtime",
    "windows_python_download",
)

PYTHON_VERSION_TAG = "20250106"

PYTHON_VERSION = "3.13.1+{PYTHON_VERSION_TAG}".format(PYTHON_VERSION_TAG = PYTHON_VERSION_TAG)

# Windows's, from python.org (see windows_python_download).
WINDOWS_PYTHON_VERSION = "3.15.2"

standalone_python_bootstrap_toolchain(
    name = "python_bootstrap",
    interpreter = shims.select({
        "config//cpu:arm64": shims.select({
            "config//os:linux": "$(location :cpython-{PYTHON_VERSION}-aarch64-unknown-linux-gnu-runtime)/bin/python3".format(PYTHON_VERSION = PYTHON_VERSION),
            "config//os:macos": "$(location :cpython-{PYTHON_VERSION}-aarch64-apple-darwin.tar.gz[python/bin/python])".format(PYTHON_VERSION = PYTHON_VERSION),
            "config//os:windows": "$(location :python-{WINDOWS_PYTHON_VERSION}-embed-arm64[python.exe])".format(WINDOWS_PYTHON_VERSION = WINDOWS_PYTHON_VERSION),
        }),
        "config//cpu:x86_64": shims.select({
            "config//os:linux": "$(location :cpython-{PYTHON_VERSION}-x86_64-unknown-linux-gnu-runtime)/bin/python3".format(PYTHON_VERSION = PYTHON_VERSION),
            "config//os:windows": "$(location :python-{WINDOWS_PYTHON_VERSION}-embed-amd64[python.exe])".format(WINDOWS_PYTHON_VERSION = WINDOWS_PYTHON_VERSION),
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
            }),
        }),
        url = "https://github.com/astral-sh/python-build-standalone/releases/download/{PYTHON_VERSION_TAG}/cpython-{PYTHON_VERSION}-{name}-{variant}.tar.gz".format(
            name = name,
            PYTHON_VERSION = PYTHON_VERSION,
            PYTHON_VERSION_TAG = PYTHON_VERSION_TAG,
            variant = variant,
        ),
        visibility = [],
    )
    # The Linux builds are stripped: their libpython is 38 MiB rather than
    # 240, and every bootstrap action carries it (see the runtimes below).
    for name, variant, sha256, bin in [
        ("aarch64-unknown-linux-gnu", "install_only_stripped", "3c720649b2af9873262429074826ef0e35f98140e38df365b36a668573a86cf0", "python/bin/python"),
        ("aarch64-apple-darwin", "install_only", "bbfc96038d0b6922fd783f6eb2c9bf9abb648531d23d236bc1a0c16bdd061944", "python/bin/python"),
        ("x86_64-unknown-linux-gnu", "install_only_stripped", "726a608e2867c2867caa2cf3f668cb15018456070eee32375675f190946650bc", "python/bin/python"),
    ]
]

[
    windows_python_download(
        name = "python-{WINDOWS_PYTHON_VERSION}-embed-{arch}".format(
            WINDOWS_PYTHON_VERSION = WINDOWS_PYTHON_VERSION,
            arch = arch,
        ),
        sha256 = sha256,
        url = "https://www.python.org/ftp/python/{WINDOWS_PYTHON_VERSION}/python-{WINDOWS_PYTHON_VERSION}-embed-{arch}.zip".format(
            WINDOWS_PYTHON_VERSION = WINDOWS_PYTHON_VERSION,
            arch = arch,
        ),
        visibility = [],
    )
    # Hashes from the release's page, python.org/downloads/release/python-3152/.
    for arch, sha256 in [
        ("amd64", "d012f3aa29cf07436dae8aea1fec0fd195c2612a0b059b1f915ae0afb9ad1f62"),
        ("arm64", "089eae5e8aba8284c2ce59df008c1dc915af46fd9e8b1227e3a7f315211567c9"),
    ]
]

# On Linux, where actions may run remotely, the interpreter is a minimal
# runtime (see make_runtime.py) rather than a file of a whole install: an
# action is given its inputs and nothing else, and python/bin/python alone
# cannot even load its libpython.
#
# Making a runtime runs the install's own interpreter, so each one builds only
# for, and only on, its own platform; a build of the whole package skips the
# other's rather than failing to execute it.
[
    standalone_python_runtime(
        name = "cpython-{PYTHON_VERSION}-{name}-runtime".format(
            name = name,
            PYTHON_VERSION = PYTHON_VERSION,
        ),
        exec_compatible_with = constraints,
        python = ":cpython-{PYTHON_VERSION}-{name}.tar.gz".format(
            name = name,
            PYTHON_VERSION = PYTHON_VERSION,
        ),
        script = "make_runtime.py",
        target_compatible_with = constraints,
        visibility = [],
    )
    for name, constraints in [
        (
            "aarch64-unknown-linux-gnu",
            [
                "config//cpu:arm64",
                "config//os:linux",
            ],
        ),
        (
            "x86_64-unknown-linux-gnu",
            [
                "config//cpu:x86_64",
                "config//os:linux",
            ],
        ),
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
    ]
]

shims.lint_package()
