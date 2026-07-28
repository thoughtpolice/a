# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//toolchains:python.bzl", "remote_python_toolchain")

PYTHON_VERSION = "3.14.6"

PYTHON_RELEASE = "20260718"

_ARCHIVE_URL = "https://github.com/astral-sh/python-build-standalone/releases/download/{release}/cpython-{version}+{release}-{triple}-install_only_stripped.tar.gz"

# The target triple and hash of every archive the toolchain can download, keyed
# by the os/cpu constraints that select() between them. Hashes come from the
# SHA256SUMS file attached to the release above; the prelude's
# python/tools/discover_python_archives.sh script prints the same set.
_CPYTHON_ARCHIVES = {
    "linux": {
        "arm64": {
            "sha256": "c2a2caa03aa9beb77a5bbb5a009c8fe77b96a56925da2dba18095237e30faf04",
            "triple": "aarch64-unknown-linux-gnu",
        },
        "x86_64": {
            "sha256": "86bf107f65fc30b56f2b263b26797fcbb1661f5315910cdbf27f733eb8738b74",
            "triple": "x86_64-unknown-linux-gnu",
        },
    },
    "macos": {
        "arm64": {
            "sha256": "5e8e0746cb0108d138f510cfbb28c4b031b9ed63bbbe3e43a34c77d4663c4fa1",
            "triple": "aarch64-apple-darwin",
        },
        "x86_64": {
            "sha256": "2d03154bc83c6d2d048bba23bb808b020e352028f5bd541a740e54467fc9cc75",
            "triple": "x86_64-apple-darwin",
        },
    },
    "windows": {
        "arm64": {
            "sha256": "89acb9184dcfcb34862905494e4a41b27df8f8364953d5796cc0f9141160d7f9",
            "triple": "aarch64-pc-windows-msvc",
        },
        "x86_64": {
            "sha256": "0c5c9f231704fb49149bc8f2b9d9dbe43eeaf6c54f362ef0fc2066ce64b4d10f",
            "triple": "x86_64-pc-windows-msvc",
        },
    },
}

# CPython, downloaded from the python-build-standalone project. To move to a
# newer interpreter, update the version, release and hashes above; the prelude's
# python/tools/discover_python_archives.sh script prints them:
#
#     discover_python_archives.sh 3.14.6 20260718
#
# 'bootstrap' is disabled: the prelude's own build tools (rustc_action, the
# python packaging scripts, ...) are bootstrap binaries and keep using
# toolchains//python-bootstrap, which downloads its interpreter without needing
# a python toolchain at all. Repository code wants shims.python_binary instead.
remote_python_toolchain(
    name = "python",
    bootstrap = False,
    cpython_urls = {
        os: {
            cpu: {
                "sha256": archive["sha256"],
                "url": _ARCHIVE_URL.format(
                    release = PYTHON_RELEASE,
                    triple = archive["triple"],
                    version = PYTHON_VERSION,
                ),
            }
            for cpu, archive in archives.items()
        }
        for os, archives in _CPYTHON_ARCHIVES.items()
    },
    visibility = ["PUBLIC"],
)
