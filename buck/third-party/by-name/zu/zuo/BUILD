# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
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
    )
    for name in [
        "zuo.h",
        "zuo.c",
        "local/image.zuo",
    ]
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
        ":local/image.zuo",
        ":stdlib",
        ":zuo.c",
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
    visibility = ["PUBLIC"],
    deps = [
        "third-party//by-name/mi/mimalloc:mimalloc",
    ],
)

# The main zuo alias points to the embedded version
depot.alias(
    name = "zuo",
    actual = ":zuo-embedded",
    visibility = ["PUBLIC"],
)
