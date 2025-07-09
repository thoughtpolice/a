# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.filegroup(
    name = "stdlib",
    srcs = glob(["lib/**"]),
)

[
    depot.export_file(
        name = name,
        src = name,
    ) for name in [ 'zuo.h', 'zuo.c', 'local/image.zuo' ]
]

# Basic Zuo executable - minimal build without embedded modules
# This is used for bootstrapping only
depot.cxx_binary(
    name = "zuo-bootstrap",
    srcs = ["zuo.c"],
)

depot.genrule(
    name = "image_zuo.c",
    srcs = [
        ":stdlib",
        ":zuo.c",
        ":local/image.zuo",
    ],
    out = "image_zuo.c",
    cmd = """
        cp $(exe :zuo-bootstrap) zuo.exe
        cp -fr stdlib/lib lib
        ./zuo.exe local/image.zuo -o $OUT --keep-collects
    """,
)

# Embedded Zuo executable with standard library
depot.cxx_binary(
    name = "zuo-embedded",
    srcs = [":image_zuo.c"],
    deps = [
        'third-party//mimalloc:mimalloc',
    ],
    visibility = ["PUBLIC"],
)

# The main zuo alias points to the embedded version
depot.alias(
    name = "zuo",
    actual = ":zuo-embedded",
    visibility = ["PUBLIC"],
)
