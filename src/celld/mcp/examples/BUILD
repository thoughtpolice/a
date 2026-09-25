# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example", "celld_example_upstream")

celld_example(
    name = "tools",
    main = "tools.ts",
    deps = [
        "root//src/celld/mcp:mcp",
        "root//src/celld/sieve:sieve",
    ],
)

celld_example(
    name = "approval",
    main = "approval.ts",
    deps = [
        "root//src/celld/mcp:mcp",
        "root//src/celld/sieve:sieve",
    ],
)

celld_example(
    name = "tasks",
    bindings = {
        "MCP_CHANGES": "McpChangeHub",
        "MCP_TASKS": "McpTasks",
    },
    main = "tasks.ts",
    deps = [
        "root//src/celld/mcp:mcp",
        "root//src/celld/sieve:sieve",
    ],
)

# The fake issuer's key set, for `protected`.
celld_example_upstream(
    name = "issuer",
    main = "issuer.ts",
    deps = ["root//src/celld/jwt:jwt"],
)

celld_example(
    name = "protected",
    kv_namespaces = {"NOTES": "mcp-example-notes"},
    main = "protected.ts",
    upstream = ":issuer",
    vars = {
        "MCP_RESOURCE": "https://notes.example.com/mcp",
        "OAUTH_ISSUER": "https://auth.example.com",
    },
    deps = [
        "root//src/celld/mcp:mcp",
        "root//src/celld/oauth:oauth",
        "root//src/celld/sieve:sieve",
    ],
)

# An MCP server with its authorization server (`@celld/oauth`'s, in memory),
# for `gateway`.
celld_example_upstream(
    name = "weather",
    main = "weather.ts",
    deps = [
        "root//src/celld/mcp:mcp",
        "root//src/celld/oauth:oauth",
        "root//src/celld/sieve:sieve",
    ],
)

celld_example(
    name = "gateway",
    main = "gateway.ts",
    upstream = ":weather",
    deps = [
        "root//src/celld/mcp:mcp",
        "root//src/celld/oauth:oauth",
    ],
)
