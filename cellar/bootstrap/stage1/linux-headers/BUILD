# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")

GCC = "cellar//bootstrap/stage1/gcc13"

MUSL = "cellar//bootstrap/stage1/musl12"

CHDIRENV = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv"

BASH = "cellar//bootstrap/stage1/bash:bash"

ARCH = "x86"

download_file(
    name = "linux-6.18.54.tar.xz",
    hash = "9df30b02dd8102bbd0be52556288ef6889ddbe7f1ddb96fbf847d0becf3eacac",
    size_bytes = 154801608,
    urls = ["https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.18.54.tar.xz"],
)

untar(
    name = "linux-6.18.54",
    chdirenv = CHDIRENV,
    decompress = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
    files = [
        "COPYING",
        "LICENSES/exceptions/Linux-syscall-note",
        "LICENSES/preferred/GPL-2.0",
        "scripts/headers_install.sh",
        "scripts/unifdef.c",
        "usr/dummy-include",
    ],
    flags = ["-x"],
    input = ":linux-6.18.54.tar.xz",
    # Only the UAPI headers, the scripts and tables that generate and install
    # headers, and the notices.
    only = [
        "COPYING",
        "LICENSES/exceptions/Linux-syscall-note",
        "LICENSES/preferred/GPL-2.0",
        "Makefile",
        "arch/" + ARCH + "/entry/syscalls",
        "arch/" + ARCH + "/include/uapi",
        "include/uapi",
        "scripts/headers_install.sh",
        "scripts/syscallhdr.sh",
        "scripts/unifdef.c",
        "usr/dummy-include",
    ],
    untar = "cellar//bootstrap/stage1/pax:untar",
)

# The bootstrap's GNU sed 4.0.9 spells extended expressions -r; it predates
# the -E alias.
exact_patch(
    name = "headers_install.sh",
    src = ":linux-6.18.54[scripts/headers_install.sh]",
    after = "sed -r -e '",
    before = "sed -E -e '",
    output = "headers_install.sh",
)

# scripts/Makefile builds unifdef as a host program with the top Makefile's
# KBUILD_HOSTCFLAGS.
c_object(
    name = "unifdef.o",
    src = ":linux-6.18.54[scripts/unifdef.c]",
    flags = [
        "-Wall",
        "-Wmissing-prototypes",
        "-Wstrict-prototypes",
        "-O2",
        "-fomit-frame-pointer",
        "-std=gnu11",
    ],
    object_name = "unifdef.o",
    toolchain = GCC + ":stage3-gcc",
)

c_binary(
    name = "unifdef",
    end_objects = [
        GCC + ":stage3-crtend.o",
        MUSL + ":crtn.o",
    ],
    libraries = [
        MUSL + ":libc.a",
        GCC + ":stage3-libgcc.a",
        MUSL + ":libc.a",
    ],
    objects = [
        MUSL + ":crt1.o",
        MUSL + ":crti.o",
        GCC + ":stage3-crtbeginT.o",
        ":unifdef.o",
    ],
    output = "unifdef",
    toolchain = GCC + ":stage3-gcc",
)

# headers_install.sh runs scripts/unifdef from the kernel's object tree.
filegroup(
    name = "objtree",
    srcs = {"scripts/unifdef": ":unifdef"},
)

filegroup(
    name = "script-tools",
    srcs = {"bin/" + name: "cellar//bootstrap/stage1/coreutils-final:" + name for name in [
        "mkdir",
        "rm",
        "sort",
        "tr",
        "basename",
    ]} | {
        "bin/find": "cellar//bootstrap/stage1/findutils:find-bin",
        "bin/grep": "cellar//bootstrap/stage1/grep:grep",
        "bin/sed": "cellar//bootstrap/stage1/sed-final:sed",
    },
)

export_file(name = "generate.sh")

export_file(name = "install.sh")

generate(
    name = "generated",
    args = [
        "--noprofile",
        "--norc",
        "$(location :generate.sh)",
        "$(location :linux-6.18.54)",
        ARCH,
        "$(location :script-tools[bin])",
    ],
    chdir = CHDIRENV,
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "LC_ALL": "C",
    },
    tool = BASH,
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
        ARCH,
        "$(location :script-tools[bin])",
    ],
    chdir = CHDIRENV,
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "LC_ALL": "C",
    },
    tool = BASH,
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

write_file(
    name = "passed",
    content = "passed\n",
)

export_file(name = "tests/headers.sh")

generate(
    name = "header-test-result",
    args = [
        "--noprofile",
        "--norc",
        "$(location :tests/headers.sh)",
        "$(location :headers)",
        "$(location :linux-6.18.54[usr/dummy-include])",
        "$(exe {}:stage3-xgcc)".format(GCC),
        "$(location {}:stage3-native-tools)".format(GCC),
        "$(location {}:compiler-headers)".format(GCC),
        "$(location {}:headers)".format(MUSL),
        "$(location :script-tools[bin])",
    ],
    chdir = CHDIRENV,
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "TMPDIR": ".",
        "LC_ALL": "C",
    },
    files = ["passed"],
    tool = BASH,
)

command_test(
    name = "header-test",
    args = [
        "$(location :header-test-result[passed])",
        "$(location :passed)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

export_file(name = "tests/futex.c")

c_object(
    name = "futex.o",
    src = ":tests/futex.c",
    flags = [
        "-std=gnu11",
        "-O2",
        "-Wall",
        "-Werror",
        "-isystem",
        "$(location :headers)",
    ],
    headers = [":headers"],
    toolchain = GCC + ":stage3-gcc",
)

c_binary(
    name = "futex",
    end_objects = [
        GCC + ":stage3-crtend.o",
        MUSL + ":crtn.o",
    ],
    libraries = [
        MUSL + ":libc.a",
        GCC + ":stage3-libgcc.a",
        MUSL + ":libc.a",
    ],
    objects = [
        MUSL + ":crt1.o",
        MUSL + ":crti.o",
        GCC + ":stage3-crtbeginT.o",
        ":futex.o",
    ],
    output = "futex",
    toolchain = GCC + ":stage3-gcc",
)

generate(
    name = "futex-output",
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = ":futex",
)

command_test(
    name = "futex-test",
    args = [
        "$(location :futex-output)",
        "$(location :passed)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)
