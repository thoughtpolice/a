# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# A library with a header from the repository and a generated one, for the
# language server's smoke test.
shims.cxx_library(
    name = "greeting",
    srcs = ["greeting.cpp"],
    exported_headers = {
        "greeting.h": "greeting.h",
        "version.h": ":version.h",
    },
    header_namespace = "greeting",
    visibility = ["toolchains//cxx/lsp/tests/..."],
)

shims.write_file(
    name = "version.h",
    contents = [
        "#pragma once",
        "#define GREETING_VERSION 1",
        "",
    ],
)
