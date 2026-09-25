# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example", "celld_example_upstream")

_DEPS = [
    "root//src/celld/router:router",
    "root//src/celld/sieve:sieve",
]

# Token hashes are not secrets; the tokens themselves are only in the spec.
celld_example(
    name = "crud",
    kv_namespaces = {"BOOKMARKS": "router-example-bookmarks"},
    main = "crud.ts",
    vars = {
        "API_TOKENS": """{"409808cfe86fdad5e656cc2de50f04deeca886950ee8d5f2ff47753031219337":{"subject":"ada","scopes":["bookmarks:read"]},"47a4a8202102e3be8b7c83b5cbcb8e2119a70f0180ea28eef4b35fc31b8c7e94":{"subject":"ada","scopes":["bookmarks:read","bookmarks:write"]},"87d34a07e447d960164f94db0b710924e26388e5043e7837f38bb8d722fc28f9":{"subject":"bob","scopes":["bookmarks:read","bookmarks:write"]}}""",
    },
    deps = _DEPS,
)

# The fake issuer's key set, for `reports`.
celld_example_upstream(
    name = "issuer",
    main = "issuer.ts",
    deps = ["root//src/celld/jwt:jwt"],
)

celld_example(
    name = "reports",
    kv_namespaces = {"REPORTS": "router-example-reports"},
    main = "reports.ts",
    upstream = ":issuer",
    deps = _DEPS + ["root//src/celld/jwt:jwt"],
)

# SESSION_SECRET stands in for a secret; a deployment sets it with
# `celld secret put`, never in the project.
celld_example(
    name = "session",
    kv_namespaces = {"NOTES": "router-example-notes"},
    main = "session.ts",
    vars = {
        "SESSION_SECRET": "example-only-secret-0123456789abcdef",
        "USERS": """{"ada":"c4bbcb1fbec99d65bf59d85c8cb62ee2db963f0fe106f483d9afa73bd4e39a8a"}""",
    },
    deps = _DEPS,
)

celld_example(
    name = "spa",
    kv_namespaces = {"PROFILES": "router-example-profiles"},
    main = "spa.ts",
    vars = {
        "API_TOKENS": """{"6d6d9ea87fe26f90584b0bef789fed7022e5c1d20c5db508e15421bf23a20780":{"subject":"ada"}}""",
        "SPA_ORIGIN": "https://app.example.com",
    },
    deps = _DEPS,
)

celld_example(
    name = "webhook",
    kv_namespaces = {"DELIVERIES": "router-example-deliveries"},
    main = "webhook.ts",
    vars = {
        "SENDER_CIDRS": "192.0.2.0/24, 2001:db8:5e::/48",
        "TRUSTED_PROXIES": "10.0.0.0/8",
        "WEBHOOK_KEYS": """{"38d72ff85940ef6323456f659ed1193d41dae0da5c342f44dc7cd8ce760ba5e8":{"subject":"billing","scopes":["hooks:deliver"]},"8a785a9d1e76f15820e9c8d1022e3bf50b2e841af66cdbe673d2f235b30f0c35":{"subject":"dashboard","scopes":["hooks:read"]}}""",
    },
    deps = _DEPS + ["root//src/celld/ip:ip"],
)
