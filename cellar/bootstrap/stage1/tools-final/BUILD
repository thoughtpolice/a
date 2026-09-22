# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "exact_patch")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")

GCC = "cellar//bootstrap/stage1/gcc47"

MUSL = "cellar//bootstrap/stage1/musl12"

CC = GCC + ":stage3-gcc"

CRT = [
    MUSL + ":crt1.o",
    MUSL + ":crti.o",
    GCC + ":stage3-crtbeginT.o",
]

CRTN = [
    GCC + ":stage3-crtend.o",
    MUSL + ":crtn.o",
]

LIBC = [
    MUSL + ":libc.a",
    GCC + ":stage3-libgcc.a",
    MUSL + ":libc.a",
]

POPEN_ENTRY = "FILE *popen(const char *cmd, const char *mode)\n{\n"

# Private copies retain musl's signal and stdio semantics. Actions set a
# declared BOOTSTRAP_SHELL; explicit empty values fail. An ordinary runtime
# caller without the variable retains musl's /bin/sh default.
[
    [
        exact_patch(
            name = name + "-guarded",
            src = MUSL + ":source[" + path + "]",
            after = prefix + "\tconst char *shell = getenv(\"BOOTSTRAP_SHELL\");\n\tif (!shell) shell = \"/bin/sh\";\n" +
                    null_command + "\tif (!*shell) { errno = ENOENT; return " + failure + "; }\n",
            before = before,
        ),
        exact_patch(
            name = name + "-source",
            src = ":" + name + "-guarded",
            after = "posix_spawn(&pid, shell,",
            before = 'posix_spawn(&pid, "/bin/sh",',
        ),
        c_object(
            name = "shell-" + name + ".o",
            src = ":" + name + "-source",
            defines = [
                "_GNU_SOURCE=1",
                name + "=bootstrap_" + name,
            ],
            flags = [
                "-Werror",
                "-O2",
                "-x",
                "c",
                "-std=c99",
                "-ffreestanding",
                "-fno-strict-aliasing",
                "-include",
                "stdlib.h",
            ],
            headers = [MUSL + ":source"],
            # do not sort
            includes = [
                MUSL + ":source[arch/x86_64]",
                MUSL + ":source[arch/generic]",
                MUSL + ":source[src/include]",
                MUSL + ":source[src/internal]",
                MUSL + ":source[include]",
            ],
            object_name = "shell-" + name + ".o",
            toolchain = CC,
        ),
    ]
    # system(NULL) reports whether a shell is available, after musl's
    # cancellation point. popen has no such query and checks on entry.
    for name, path, before, prefix, null_command, failure in [
        ("system", "src/process/system.c", "\tif (!cmd) return 1;\n", "", "\tif (!cmd) return *shell != 0;\n", "-1"),
        ("popen", "src/stdio/popen.c", POPEN_ENTRY, POPEN_ENTRY, "", "NULL"),
    ]
]

# Matching musl copyright for the private system/popen implementation sources.
filegroup(
    name = "shell-license",
    srcs = {"COPYRIGHT": MUSL + ":source[COPYRIGHT]"},
)

c_library(
    name = "libshell.a",
    objects = [
        ":shell-system.o",
        ":shell-popen.o",
    ],
    output = "libshell.a",
    toolchain = CC,
)

c_object(
    name = "shell-test.o",
    src = "tests/shell.c",
    flags = [
        "-O2",
        "-Werror",
    ],
    toolchain = CC,
)

c_binary(
    name = "shell-test",
    libraries = [":libshell.a"] + LIBC,
    objects = CRT + [":shell-test.o"] + CRTN,
    toolchain = CC,
)

command_test(
    name = "shell-and-stream-semantics",
    env = {
        "BOOTSTRAP_SHELL": "$(exe cellar//bootstrap/stage1/bash:bash)",
        "CELLAR_BOOTSTRAP_IDENTITY": "1",
        "PATH": "/nonexistent-bootstrap-path",
    },
    tool = ":shell-test",
)

command_test(
    name = "reject-empty-shell",
    args = ["missing"],
    env = {"BOOTSTRAP_SHELL": ""},
    tool = ":shell-test",
)
