# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load(
    "@cellar//bootstrap/mes:defs.bzl",
    "download_file",
    "ungz",
    "untar",
)

VERSION = "1.00.2"
LINUX_COMPAT = ["cellar//bootstrap/platforms:linux"]

download_file(
    name = "nyacc-{}.tar.gz".format(VERSION),
    target_compatible_with = LINUX_COMPAT,
    hash = "f36e4fb7dd524dc3f4b354d3d5313f69e7ce5a6ae93711e8cf6d51eaa8d2b318",
    urls = [
        "https://mirror.easyname.at/nongnu/nyacc/nyacc-{}.tar.gz".format(VERSION),
    ],
)

ungz(
    name = "nyacc-{}.tar".format(VERSION),
    target_compatible_with = LINUX_COMPAT,
    input = ":nyacc-{}.tar.gz".format(VERSION),
    ungz = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name = "nyacc-{}".format(VERSION),
    target_compatible_with = LINUX_COMPAT,
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    input = ":nyacc-{}.tar".format(VERSION),
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)
