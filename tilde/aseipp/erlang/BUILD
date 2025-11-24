# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.erlang_app(
    name = "app",
    srcs = glob(["*.erl"]),
    applications = [],
)

depot.erlang_escript(
    name = "hello",
    main_module = "hello",
    deps = [":app"],
)
