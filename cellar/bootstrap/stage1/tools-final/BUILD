# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "write_file")
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

# Private copies retain musl's signal and stdio semantics. Actions set a
# declared BOOTSTRAP_SHELL; explicit empty values fail. An ordinary runtime
# caller without the variable retains musl's /bin/sh default.
write_file(
    name = "shell-path.before",
    content = 'posix_spawn(&pid, "/bin/sh",',
)

write_file(
    name = "shell-path.after",
    content = "posix_spawn(&pid, shell,",
)

[
    [
        write_file(
            name = name + "-guard.before",
            content = signature + "\n{\n",
        ),
        write_file(
            name = name + "-guard.after",
            content = signature + "\n{\n\tconst char *shell = getenv(\"BOOTSTRAP_SHELL\");\n" +
                      "\tif (!shell) shell = \"/bin/sh\";\n\tif (!*shell) { errno = ENOENT; return " + failure + "; }\n",
        ),
        generate(
            name = name + "-guarded",
            args = [
                "$(location " + MUSL + ":source[" + path + "])",
                "$(location :" + name + "-guard.before)",
                "$(location :" + name + "-guard.after)",
            ],
            tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
        ),
        generate(
            name = name + "-source",
            args = [
                "$(location :" + name + "-guarded)",
                "$(location :shell-path.before)",
                "$(location :shell-path.after)",
            ],
            tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
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
    for name, path, signature, failure in [
        ("system", "src/process/system.c", "int system(const char *cmd)", "-1"),
        ("popen", "src/stdio/popen.c", "FILE *popen(const char *cmd, const char *mode)", "NULL"),
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
        "BOOTSTRAP_SHELL": "$(location cellar//bootstrap/stage1/bash:bash)",
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
