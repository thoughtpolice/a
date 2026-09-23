# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "concatenate", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "exact_patch", "write_file")
load("@cellar//bootstrap/stage0-posix/mescc-tools-extra:defs.bzl", "cc")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")

cc(
    name = "expect-exit",
    src = "expect-exit.c",
    arch = "amd64",
    os = "Linux",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
    tools = "cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
)

[
    cc(
        name = name,
        src = name + ".c",
        arch = "amd64",
        os = "Linux",
        target_compatible_with = [
            "cellar//bootstrap/platforms:linux",
            "cellar//bootstrap/platforms:amd64",
        ],
        tools = "cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
    )
    for name in [
        "capture",
        "capture-probe",
        "source-alias",
    ]
]

write_file(
    name = "expected-output",
    content = "declared:argument\n",
)

generate(
    name = "captured-output",
    args = [
        "0",
        "argument",
    ],
    capture = ":capture",
    env = {"CAPTURE_TEST": "declared"},
    tool = ":capture-probe",
)

command_test(
    name = "capture-output",
    args = [
        "$(location :captured-output)",
        "$(location :expected-output)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

command_test(
    name = "capture-exit-status",
    args = [
        "37",
        "$(exe :capture)",
        "/dev/null",
        "$(exe :capture-probe)",
        "37",
        "argument",
    ],
    tool = ":expect-exit",
)

# Missing executables stay inside a declared input directory, including in
# process traces used to audit the bootstrap's execution closure.
filegroup(
    name = "missing-program-directory",
    srcs = {},
)

command_test(
    name = "capture-exec-failure",
    args = [
        "127",
        "$(exe :capture)",
        "/dev/null",
        "$(location :missing-program-directory)/missing-program",
    ],
    tool = ":expect-exit",
)

filegroup(
    name = "input-directory",
    srcs = {"relative-input": ":expected-output"},
)

write_file(
    name = "io-expected",
    content = "declared:argument\ndeclared:argument\n",
)

generate(
    name = "io-output",
    args = [
        "io",
        "relative-input",
    ],
    capture = ":capture",
    stdin = ":expected-output",
    tool = ":capture-probe",
    working_directory = ":input-directory",
)

command_test(
    name = "capture-stdin-and-directory",
    args = [
        "$(location :io-output)",
        "$(location :io-expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

command_test(
    name = "capture-missing-input",
    args = [
        "1",
        "$(exe :capture)",
        "--stdin",
        "/nonexistent-bootstrap-input",
        "/dev/null",
        "$(exe :capture-probe)",
    ],
    tool = ":expect-exit",
)

write_file(
    name = "concat-tail",
    content = "tail",
)

write_file(
    name = "concat-expected",
    content = "taildeclared:argument\ntail",
)

concatenate(
    name = "concat-output",
    inputs = [
        ":concat-tail",
        ":expected-output",
        ":concat-tail",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
)

command_test(
    name = "concatenate-order",
    args = [
        "$(location :concat-output)",
        "$(location :concat-expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

MUSL = "cellar//bootstrap/stage1/musl"

c_object(
    name = "withenv.o",
    src = "withenv.c",
    flags = ["-Werror"],
    headers = [MUSL + ":headers"],
    object_name = "withenv.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "withenv",
    end_objects = [
        MUSL + ":restored-crtn.o",
    ],
    libraries = [
        MUSL + ":restored-libc.a",
        "cellar//bootstrap/stage1/tcc-musl:musl2-libtcc1.a",
        MUSL + ":restored-libc.a",
    ],
    objects = [
        MUSL + ":restored-crt1.o",
        MUSL + ":restored-crti.o",
        ":withenv.o",
    ],
    output = "withenv",
    toolchain = MUSL + ":tcc",
)

configured_tool(
    name = "configured-probe",
    args = [
        "0",
        "argument",
    ],
    env = {"CAPTURE_TEST": "declared"},
    env_tool = ":withenv",
    tool = ":capture-probe",
)

generate(
    name = "configured-output",
    capture = ":capture",
    env = {"CAPTURE_TEST": "overridden"},
    tool = ":configured-probe",
)

command_test(
    name = "configured-environment",
    args = [
        "$(location :configured-output)",
        "$(location :expected-output)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

configured_tool(
    name = "configured-directory",
    args = [
        "--noprofile",
        "--norc",
        "-c",
        'IFS= read -r line < "$DECLARED_INPUT"; test "$INHERITED_VALUE" = expected || exit 1; printf "%s\\n" "$line"',
    ],
    env = {"DECLARED_INPUT": "$(location :expected-output)"},
    env_tool = ":withenv",
    tool = "cellar//bootstrap/stage1/bash-bootstrap:bash",
)

generate(
    name = "configured-io",
    capture = ":capture",
    env = {"INHERITED_VALUE": "expected"},
    tool = ":configured-directory",
    working_directory = ":input-directory",
)

command_test(
    name = "configured-relative-directory",
    args = [
        "$(location :configured-io)",
        "$(location :expected-output)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

command_test(
    name = "withenv-failure",
    args = [
        "127",
        "$(exe :withenv)",
        "--",
        "$(location :missing-program-directory)/missing-program",
    ],
    tool = ":expect-exit",
)

POPEN_ENTRY = "FILE *popen(const char *cmd, const char *mode)\n{\n"

# Use the matching musl implementations, preserving their signal/stdio semantics.
# Only the shell path changes; an absent declared shell fails instead of finding
# the executor's /bin/sh. These objects have private bootstrap symbol names.
[
    [
        exact_patch(
            name = name + "-guarded",
            src = MUSL + ":source-restored[" + path + "]",
            after = prefix + "\tconst char *shell = getenv(\"BOOTSTRAP_SHELL\");\n" + null_command +
                    "\tif (!shell || !*shell) { errno = ENOENT; return " + failure + "; }\n",
            before = before,
        ),
        exact_patch(
            name = name + "-source",
            src = ":" + name + "-guarded",
            after = "shell",
            before = '"/bin/sh"',
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
                "-include",
                "stdlib.h",
            ],
            headers = [MUSL + ":source-restored"],
            # do not sort
            includes = [
                MUSL + ":source-restored[arch/x86_64]",
                MUSL + ":source-restored[arch/generic]",
                MUSL + ":source-restored[src/include]",
                MUSL + ":source-restored[src/internal]",
                MUSL + ":source-restored[include]",
            ],
            object_name = "shell-" + name + ".o",
            toolchain = MUSL + ":restored-predecessor",
        ),
    ]
    # system(NULL) reports whether a shell is available, after musl's
    # cancellation point. popen has no such query and checks on entry.
    for name, path, before, prefix, null_command, failure in [
        ("system", "src/process/system.c", "\tif (!cmd) return 1;\n", "", "\tif (!cmd) return shell && *shell;\n", "-1"),
        ("popen", "src/stdio/popen.c", POPEN_ENTRY, POPEN_ENTRY, "", "NULL"),
    ]
]

# Matching musl copyright for the private system/popen implementation sources.
filegroup(
    name = "shell-license",
    srcs = {"COPYRIGHT": MUSL + ":source-restored[COPYRIGHT]"},
)

c_library(
    name = "libshell.a",
    objects = [
        ":shell-system.o",
        ":shell-popen.o",
    ],
    output = "libshell.a",
    toolchain = MUSL + ":tcc",
)
