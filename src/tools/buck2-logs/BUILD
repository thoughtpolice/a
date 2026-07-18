# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//deno:defs.bzl", "deno")

deno.binary(
    name = "upload",
    config = "deno.jsonc",
    main = "upload.ts",
    permissions = [
        "read",
        "net",
    ],
    type = "run",
    unstable_features = ["kv"],
    visibility = ["PUBLIC"],
)

deno.binary(
    name = "server",
    config = "deno.jsonc",
    main = "server.ts",
    permissions = [
        "net",
        "env=" + ",".join(
            [
                "DENO_KV_URL",
                "DENO_DEPLOYMENT_ID",
            ],
        ),
    ],
    type = "serve",
    unstable_features = ["kv"],
    visibility = ["PUBLIC"],
)
