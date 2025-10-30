# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//deno:defs.bzl", "deno")

deno.binary(
    name="server",
    main="bin/server.ts",
    srcs=glob(["*.ts"]),
    type="run",
    config="deno.jsonc",
    permissions=["net", "read", "env=NODE_ENV"],
    unstable_features=["kv"],
)

deno.binary(
    name="client",
    main="bin/client.ts",
    srcs=glob(["*.ts"]),
    type="run",
    config="deno.jsonc",
    permissions=["net", "read", "write", "env=NODE_ENV"],
    unstable_features=["kv"],
)
