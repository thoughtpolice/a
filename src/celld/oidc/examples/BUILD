# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example", "celld_example_upstream")

celld_example(
    name = "provider",
    bindings = {"OAUTH_RECORDS": "OAuthRecords"},
    main = "provider.ts",
    deps = [
        "root//src/celld/oauth:oauth",
        "root//src/celld/oidc:oidc",
        "root//src/celld/router:router",
    ],
)

# A fake OpenID Provider for `login`; see login_upstream.ts.
celld_example_upstream(
    name = "login-upstream",
    main = "login_upstream.ts",
    deps = ["root//src/celld/oidc:oidc"],
)

celld_example(
    name = "login",
    main = "login.ts",
    upstream = ":login-upstream",
    deps = [
        "root//src/celld/oauth:oauth",
        "root//src/celld/oidc:oidc",
        "root//src/celld/router:router",
    ],
)

celld_example(
    name = "federation",
    main = "federation.ts",
    deps = [
        "root//src/celld/oauth:oauth",
        "root//src/celld/oidc:oidc",
        "root//src/celld/router:router",
    ],
)

# A fake upstream OpenID Provider for `broker`; see broker_upstream.ts.
celld_example_upstream(
    name = "broker-upstream",
    main = "broker_upstream.ts",
    deps = ["root//src/celld/oidc:oidc"],
)

celld_example(
    name = "broker",
    bindings = {"OAUTH_RECORDS": "OAuthRecords"},
    main = "broker.ts",
    upstream = ":broker-upstream",
    deps = [
        "root//src/celld/jwt:jwt",
        "root//src/celld/oauth:oauth",
        "root//src/celld/oidc:oidc",
    ],
)
