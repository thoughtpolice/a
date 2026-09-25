# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example", "celld_example_upstream")

# The authorization server, with a notes API on @celld/router. Its signing
# key, client secret and demo password come from the spec's `vars`
# (`.dev.vars`); a deployment keeps them as secrets.
celld_example(
    name = "server",
    bindings = {"OAUTH_RECORDS": "OAuthRecords"},
    main = "server.ts",
    deps = [
        "root//src/celld/jwt:jwt",
        "root//src/celld/oauth:oauth",
        "root//src/celld/router:router",
        "root//src/celld/sieve:sieve",
    ],
)

# Another team's reports API and its authorization server, from
# @celld/oauth/testing; see service_upstream.ts.
celld_example_upstream(
    name = "service-upstream",
    main = "service_upstream.ts",
    deps = [
        "root//src/celld/jwt:jwt",
        "root//src/celld/oauth:oauth",
    ],
)

celld_example(
    name = "service",
    main = "service.ts",
    upstream = ":service-upstream",
    deps = [
        "root//src/celld/jwt:jwt",
        "root//src/celld/oauth:oauth",
        "root//src/celld/router:router",
        "root//src/celld/sieve:sieve",
    ],
)

# A files API that takes only DPoP-bound tokens, with nonces and replay
# checks at both servers; see dpop_upstream.ts.
celld_example_upstream(
    name = "dpop-upstream",
    main = "dpop_upstream.ts",
    deps = ["root//src/celld/oauth:oauth"],
)

celld_example(
    name = "dpop",
    main = "dpop.ts",
    upstream = ":dpop-upstream",
    deps = [
        "root//src/celld/oauth:oauth",
        "root//src/celld/router:router",
    ],
)

celld_example(
    name = "device",
    bindings = {"OAUTH_RECORDS": "OAuthRecords"},
    main = "device.ts",
    deps = [
        "root//src/celld/jwt:jwt",
        "root//src/celld/oauth:oauth",
    ],
)

celld_example(
    name = "exchange",
    bindings = {"OAUTH_RECORDS": "OAuthRecords"},
    main = "exchange.ts",
    deps = [
        "root//src/celld/jwt:jwt",
        "root//src/celld/oauth:oauth",
    ],
)
