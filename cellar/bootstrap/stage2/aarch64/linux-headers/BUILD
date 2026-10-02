# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "untar")
load("@cellar//bootstrap/platforms:defs.bzl", "amd64_dep")

OLD = "cellar//bootstrap/stage1/linux-headers"

[amd64_dep(
    name = name,
    actual = OLD + ":" + name,
) for name in [
    "linux-6.18.54.tar.xz",
    "script-tools",
    "objtree",
    "headers_install.sh",
    "generate.sh",
    "install.sh",
]]

untar(
    name = "linux-6.18.54",
    decompress = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
    files = [
        "COPYING",
        "LICENSES/exceptions/Linux-syscall-note",
        "LICENSES/preferred/GPL-2.0",
    ],
    flags = ["-x"],
    input = ":linux-6.18.54.tar.xz",
    only = [
        "COPYING",
        "LICENSES/exceptions/Linux-syscall-note",
        "LICENSES/preferred/GPL-2.0",
        "Makefile",
        "arch/arm64/include/uapi",
        "arch/arm64/tools/syscall_64.tbl",
        "scripts/syscall.tbl",
        "scripts/syscallhdr.sh",
        "include/uapi",
    ],
    target_cpu = "arm64",
    untar = "cellar//bootstrap/stage1/pax:untar",
)

generate(
    name = "generated",
    args = [
        "--noprofile",
        "--norc",
        "$(location :generate.sh)",
        "$(location :linux-6.18.54)",
        "arm64",
        "$(location :script-tools[bin])",
    ],
    chdir = True,
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "LC_ALL": "C",
    },
    target_cpu = "arm64",
    tool = "cellar//bootstrap/stage1/bash:bash",
)

generate(
    name = "headers",
    args = [
        "--noprofile",
        "--norc",
        "$(location :install.sh)",
        "$(location :linux-6.18.54)",
        "$(location :generated)",
        "$(location :objtree)",
        "$(location :headers_install.sh)",
        "arm64",
        "$(location :script-tools[bin])",
    ],
    chdir = True,
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "LC_ALL": "C",
    },
    target_cpu = "arm64",
    tool = "cellar//bootstrap/stage1/bash:bash",
)

filegroup(
    name = "installation",
    srcs = {
        "include": ":headers",
        "share/licenses/linux/COPYING": ":linux-6.18.54[COPYING]",
        "share/licenses/linux/GPL-2.0": ":linux-6.18.54[LICENSES/preferred/GPL-2.0]",
        "share/licenses/linux/Linux-syscall-note": ":linux-6.18.54[LICENSES/exceptions/Linux-syscall-note]",
    },
)
