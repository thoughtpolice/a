# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//:paths.bzl", "paths")
load("@root//buck/shims:shims.bzl", depot = "shims")

depot.cxx_library(
    name = "crypto",
    srcs = glob(["src/crypto/*.c"]),
    exported_headers = {
        "gimli.h": "src/crypto/gimli.h",
        "strobe.h": "src/crypto/strobe.h",
    },
    header_namespace = "crypto",
    # Override package default - crypto library is cross-platform
    target_compatible_with = None,
)

depot.cxx_library(
    name = "util",
    srcs = glob(["src/util/*.c"]),
    exported_headers = {
        "co.h": "src/util/co.h",
        "file_size.h": "src/util/file_size.h",
        "log.h": "src/util/log.h",
        "macros.h": "src/util/macros.h",
        "password.h": "src/util/password.h",
        "vsb.h": "src/util/vsb.h",
    },
    header_namespace = "util",
    deps = [
        "third-party//by-name/mi/mimalloc:mimalloc",
    ] + [
        ":crypto",
    ],
)

depot.cxx_library(
    name = "io",
    srcs = glob(["src/io/*.c"]),
    exported_headers = {
        "ring.h": "src/io/ring.h",
        "async.h": "src/io/async.h",
    },
    header_namespace = "io",
    deps = [
        "third-party//by-name/li/liburing:liburing",
        "third-party//by-name/mi/mimalloc:mimalloc",
    ] + [
        ":crypto",
        ":util",
    ],
)

depot.cxx_binary(
    name = "copy-file",
    srcs = glob(["copy-file/*.c"]),
    deps = [
        ":crypto",
        ":io",
        ":util",
    ] + [
        "third-party//by-name/li/liburing:liburing",
        "third-party//by-name/mi/mimalloc:mimalloc",
    ],
)

TESTS = [
    "gimli",
    "co",
]

depot.test_suite(
    name = "tests",
    tests = [":test-{}".format(t) for t in TESTS],
)

[
    depot.cxx_binary(
        name = "test-{}-exe".format(t),
        srcs = ["t/{}.c".format(t)],
        deps = [
            ":crypto",
            ":util",
        ] + [
            "third-party//by-name/li/liburing:liburing",
            "third-party//by-name/mi/mimalloc:mimalloc",
        ],
    )
    for t in TESTS
]

[
    depot.command_test(
        name = "test-{}".format(t),
        cmd = ["$(exe :test-{}-exe)".format(t)],
    )
    for t in TESTS
]
