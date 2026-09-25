# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example", "celld_example_upstream")
load("@toolchains//celld:defs.bzl", "celld")

_DEPS = [
    "root//src/celld/core:core",
    "root//src/celld/web/router:router",
    "root//src/celld/sieve:sieve",
]

# Credential tables (API_TOKENS, USERS, WEBHOOK_KEYS) and SESSION_SECRET
# are only in each spec's `vars`, which reach `.dev.vars` and never the
# deployed project; their values are public example credentials. A
# deployment sets its own with `celld secret put`, and each Worker refuses
# every credential (or answers an opaque 500, for SESSION_SECRET) while
# they are unset.
celld_example(
    name = "crud",
    kv_namespaces = {"BOOKMARKS": "router-example-bookmarks"},
    main = "crud.ts",
    deps = _DEPS,
)

# The fake issuer's key set, for `reports`.
celld_example_upstream(
    name = "issuer",
    main = "issuer.ts",
    deps = ["root//src/celld/sec/jwt:jwt"],
)

celld_example(
    name = "reports",
    kv_namespaces = {"REPORTS": "router-example-reports"},
    main = "reports.ts",
    upstream = ":issuer",
    deps = _DEPS + ["root//src/celld/sec/jwt:jwt"],
)

celld_example(
    name = "session",
    kv_namespaces = {"NOTES": "router-example-notes"},
    main = "session.ts",
    deps = _DEPS,
)

celld_example(
    name = "spa",
    kv_namespaces = {"PROFILES": "router-example-profiles"},
    main = "spa.ts",
    vars = {
        "SPA_ORIGIN": "https://app.example.com",
    },
    deps = _DEPS,
)

celld_example(
    name = "webhook",
    bindings = {"DELIVERIES": "Delivery"},
    main = "webhook.ts",
    vars = {
        "SENDER_CIDRS": "192.0.2.0/24, 2001:db8:5e::/48",
        "TRUSTED_PROXIES": "10.0.0.0/8",
    },
    deps = _DEPS + ["root//src/celld/core:core"],
)

# Concurrent copies of one delivery, which the spec's one-at-a-time steps
# cannot send: exactly one may be accepted.
celld.test(
    name = "webhook_race-test",
    srcs = [
        "webhook.ts",
        "webhook_race_test.ts",
    ],
    fake_runtime = True,
    deps = _DEPS + [
        "root//src/celld/core:core",
    ],
)

# DB-CALL-005: the crud example's OpenAPI document is generated once.
celld.test(
    name = "crud_openapi-test",
    srcs = [
        "crud.ts",
        "crud_openapi_test.ts",
    ],
    fake_runtime = True,
    deps = _DEPS + ["root//src/celld/core:core"],
)
