# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//deno:defs.bzl", "deno")

deno.binary(
    name="upload",
    main="upload.ts",
    type="run",
    permissions=["read", "net"],
    unstable_features=["kv"],
    visibility=["PUBLIC"],
)

deno.binary(
    name="server",
    main="server.ts",
    type="serve",
    permissions=[
        "net",
        "env="
        + ",".join(
            [
                "DENO_KV_URL",
                "DENO_DEPLOYMENT_ID",
            ]
        ),
    ],
    unstable_features=["kv"],
    visibility=["PUBLIC"],
)
