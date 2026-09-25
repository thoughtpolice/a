# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example", "celld_example_upstream")

celld_example(
    name = "session",
    kv_namespaces = {"REVOKED": "jwt-example-revoked"},
    main = "session.ts",
    vars = {"SESSION_TTL": "PT1H"},
    deps = [
        "root//src/celld/isotime:isotime",
        "root//src/celld/jwt:jwt",
        "root//src/celld/ulid:ulid",
    ],
)

celld_example(
    name = "issuer",
    bindings = {"KEYS": "SigningKeys"},
    main = "issuer.ts",
    vars = {
        "AUDIENCE": "https://api.example",
        "ISSUER": "https://issuer.example",
        "SIGNING_ALG": "ES256",
        "TOKEN_TTL": "PT5M",
    },
    deps = [
        "root//src/celld/isotime:isotime",
        "root//src/celld/jwt:jwt",
        "root//src/celld/ulid:ulid",
    ],
)

celld_example(
    name = "webhook",
    bindings = {"DELIVERIES": "Deliveries"},
    main = "webhook.ts",
    vars = {
        "ALLOWED_SOURCES": "192.0.2.0/24, 198.51.100.0/24",
        "AUDIENCE": "https://hooks.example/webhooks",
    },
    deps = [
        "root//src/celld/ip:ip",
        "root//src/celld/jwt:jwt",
    ],
)

# A fake authorization server for the gateway; see upstream.ts.
celld_example_upstream(
    name = "upstream",
    main = "upstream.ts",
    deps = ["root//src/celld/jwt:jwt"],
)

celld_example(
    name = "gateway",
    main = "gateway.ts",
    upstream = ":upstream",
    vars = {
        "AUDIENCE": "https://api.example",
        "JWKS_COOLDOWN_MS": "30000",
    },
    deps = ["root//src/celld/jwt:jwt"],
)
