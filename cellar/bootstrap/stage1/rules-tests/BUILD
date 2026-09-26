# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "compare_test", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "bootstrap_artifact", "c_binary", "c_library", "c_object", "compiler")

# Separate compilation through an archive with MesCC, and conditional values
# that survive MesCC's register spills.
compiler(
    name = "mescc",
    abi = "x86_64-mes",
    archive_format = "mes-concat",
    archiver = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
    cflags = [
        "-nostdinc",
        "-I",
        "$(location cellar//bootstrap/mes:mes-src[include])",
    ],
    compiler = "cellar//bootstrap/mes:mescc",
    family = "mescc",
    ldflags = ["-nostdlib"],
    object_format = "mes",
)

[
    bootstrap_artifact(
        name = name,
        src = src,
        abi = "x86_64-mes",
        kind = kind,
        object_format = "mes",
    )
    for name, src, kind in [
        ("crt", "cellar//bootstrap/mes:s3-crt1[crt1.o]", "object"),
        ("libc", "cellar//bootstrap/mes:s3-libc.a", "library"),
        ("libmescc", "cellar//bootstrap/mes:s3-libmescc.a", "library"),
    ]
]

c_object(
    name = "main.o",
    src = "main.c",
    object_name = "main.o",
    toolchain = ":mescc",
)

c_object(
    name = "answer.o",
    src = "answer.c",
    object_name = "answer.o",
    toolchain = ":mescc",
)

c_library(
    name = "answer.a",
    objects = [":answer.o"],
    output = "answer.a",
    toolchain = ":mescc",
)

c_binary(
    name = "separate-compilation",
    libraries = [
        ":answer.a",
        ":libc",
        ":libmescc",
    ],
    objects = [
        ":crt",
        ":main.o",
    ],
    toolchain = ":mescc",
)

command_test(
    name = "mescc-runinfo",
    tool = ":separate-compilation",
)

c_object(
    name = "conditional.o",
    src = "conditional.c",
    object_name = "conditional.o",
    toolchain = ":mescc",
)

c_binary(
    name = "conditional-program",
    libraries = [
        ":libc",
        ":libmescc",
    ],
    objects = [
        ":crt",
        ":conditional.o",
    ],
    toolchain = ":mescc",
)

command_test(
    name = "mescc-conditionals",
    tool = ":conditional-program",
)

# A whole header tree together with projected source and include inputs,
# compiled by TCC 0.9.26. Under @cellar//bootstrap/platforms/sandbox this
# checks that the private header next to the source stays visible.
filegroup(
    name = "header-tree",
    srcs = {
        "include/public.h": "tree-public.h",
        "src/main.c": "tree-input.c",
        "src/private.h": "tree-private.h",
    },
)

c_object(
    name = "header-tree.o",
    src = ":header-tree[src/main.c]",
    headers = [":header-tree"],
    includes = [":header-tree[include]"],
    object_name = "headers.o",
    toolchain = "cellar//bootstrap/stage1/tcc:tcc",
)

c_binary(
    name = "header-tree-program",
    flags = [
        "-nostdlib",
        "-static",
    ],
    libraries = [
        "cellar//bootstrap/stage1/tcc:boot2-libc.a",
        "cellar//bootstrap/stage1/tcc:boot2-libtcc1.a",
        "cellar//bootstrap/stage1/tcc:boot2-libc.a",
    ],
    objects = [
        "cellar//bootstrap/stage1/tcc:boot2-crt1.o",
        ":header-tree.o",
    ],
    toolchain = "cellar//bootstrap/stage1/tcc:tcc",
)

command_test(
    name = "header-tree-inputs",
    tool = ":header-tree-program",
)

# The same for generator and test inputs, run by the bootstrap Bash.
filegroup(
    name = "generator-tree",
    srcs = {
        "generate.sh": "tree-generator.sh",
        "private.sh": "tree-data.sh",
    },
)

generate(
    name = "generated-tree-file",
    args = [
        "$(location :generator-tree[generate.sh])",
        "$(location :generator-tree)",
    ],
    inputs = [":generator-tree"],
    tool = "cellar//bootstrap/stage1/bash-bootstrap:bash",
)

write_file(
    name = "tree-expected",
    content = "declared tree\n",
)

compare_test(
    name = "generator-tree-inputs",
    actual = ":generated-tree-file",
    expected = ":tree-expected",
)

command_test(
    name = "command-tree-inputs",
    args = [
        "$(location :generator-tree[generate.sh])",
        "$(location :generator-tree)",
        "/dev/null",
    ],
    inputs = [":generator-tree"],
    tool = "cellar//bootstrap/stage1/bash-bootstrap:bash",
)

# Logical source paths give identical objects and preprocessor output from
# two source trees, through GCC 4.0.4 rebuilt against musl 1.2.5.
GCC = "cellar//bootstrap/stage1/gcc40-rebuilt"

write_file(
    name = "sample.c",
    content = """#include <string.h>
#include "detail.h"
const char *source_name = __FILE__;
int main(void) {
    return strcmp(source_name, "source/sample.c") ||
           strcmp(header_name, "source/include/detail.h");
}
""",
)

write_file(
    name = "detail.h",
    content = "static const char *header_name = __FILE__;\n",
)

[
    [
        write_file(
            name = "identity-" + stage,
            content = stage,
        ),
        filegroup(
            name = "tree-" + stage,
            srcs = {
                "sample.c": ":sample.c",
                "include/detail.h": ":detail.h",
                "stage-identity": ":identity-" + stage,
            },
        ),
        c_object(
            name = "object-" + stage,
            src = ":tree-" + stage + "[sample.c]",
            flags = [
                "-O2",
                "-Werror",
            ],
            logical_includes = ["include"],
            logical_source = "sample.c",
            object_name = "sample.o",
            source_tree = ":tree-" + stage,
            toolchain = GCC + ":gcc",
        ),
        generate(
            name = "preprocessed-" + stage,
            args = [
                "-E",
                "-P",
                "-Isource/include",
                "source/sample.c",
                "-o",
                "preprocessed.c",
            ],
            chdir = True,
            directory = True,
            files = ["preprocessed.c"],
            source_tree = ":tree-" + stage,
            tool = GCC + ":gcc",
        ),
    ]
    for stage in [
        "a",
        "b",
    ]
]

compare_test(
    name = "logical-object-identity",
    actual = ":object-a",
    expected = ":object-b",
)

compare_test(
    name = "logical-generator-identity",
    actual = ":preprocessed-a[preprocessed.c]",
    expected = ":preprocessed-b[preprocessed.c]",
)

c_binary(
    name = "logical-paths-program",
    objects = [":object-a"],
    runtime = GCC + ":link-runtime",
    toolchain = GCC + ":gcc",
)

command_test(
    name = "logical-paths",
    tool = ":logical-paths-program",
)
