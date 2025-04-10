# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", depot="shims")

depot.ocaml_library(
    name="lib",
    srcs=["lib.ml"],
)

depot.ocaml_binary(
    name="hello",
    srcs=["main.ml"],
    deps=[
        ":lib",
    ],
)
