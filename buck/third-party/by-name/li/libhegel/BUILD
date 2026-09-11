# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

# Reindeer exports the source archive, so take the header from the same
# version that supplies the engine instead of maintaining a separate copy.
shims.genrule(
    name = "hegel.h",
    out = "hegel.h",
    cmd = 'cp "$(location third-party//rust:hegeltest-c-{}-headers)/hegeltest-c-{}.crate/include/hegel.h" "$OUT"'.format(
        VERSION.rsplit(".", 1)[0],
        VERSION,
    ),
)

# A crate root makes Buck's bundled cdylib/staticlib outputs available with
# stable names. The Rust dependency graph remains owned by Reindeer.
shims.rust_library(
    name = "engine",
    srcs = ["lib.rs"],
    crate = "hegel",
    soname = shims.select({
        "config//os:windows": "hegel.dll",
        "DEFAULT": "libhegel.$(ext)",
    }),
    deps = [
        "third-party//rust:hegeltest-c",
    ],
)

# C/C++ consumers get both <hegel.h> and the native Rust link dependencies.
shims.cxx_library(
    name = "libhegel",
    exported_deps = [":engine"],
    exported_headers = {"hegel.h": ":hegel.h"},
    header_namespace = "",
)

shims.alias(
    name = "shared",
    actual = ":engine[cdylib]",
)

shims.export_file(
    name = "static",
    src = ":engine[staticlib]",
    out = shims.select({
        "config//os:windows": "hegel.lib",
        "DEFAULT": "libhegel.a",
    }),
)

shims.alias(
    name = "rust",
    actual = "third-party//rust:hegeltest",
)

[
    shims.cxx_binary(
        name = "test-{}-exe".format(style),
        srcs = ["test.c"],
        link_style = style,
        # Buck's "static" Rust archive contains non-PIC code. Use static_pic
        # for PIE executables, or disable the compiler's implicit PIE default.
        linker_flags = shims.select({
            "config//os:linux": ["-no-pie"] if style == "static" else [],
            "DEFAULT": [],
        }),
        preprocessor_flags = ['-DHEGEL_EXPECTED_VERSION="{}"'.format(VERSION)],
        deps = [":libhegel"],
    )
    for style in [
        "static",
        "static_pic",
        "shared",
    ]
]

[
    shims.command_test(
        name = "test-{}".format(style),
        cmd = ["$(exe :test-{}-exe)".format(style)],
    )
    for style in [
        "static",
        "static_pic",
        "shared",
    ]
]

shims.python_binary(
    name = "test-dlopen-exe",
    main = "test_dlopen.py",
)

# ctypes loads the standalone cdylib, without a Buck native link graph.
shims.command_test(
    name = "test-dlopen",
    cmd = [
        "$(exe :test-dlopen-exe)",
        "$(location :shared)",
        "$(location :hegel.h)",
        VERSION,
    ],
)
