# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.erlang_app(
    name = "hello_app",
    srcs = glob(["src/*.erl"]),
    app_src = "src/hello_app.app.src",
    version = "0.1.0",
    visibility = ["PUBLIC"],
)

depot.erlang_escript(
    name = "hello_cli",
    main_module = "hello_cli",
    deps = [":hello_app"],
)
