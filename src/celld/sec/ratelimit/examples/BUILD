# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")

_DEPS = [
    "root//src/celld/sec/ratelimit:ratelimit",
    "root//src/celld/web/router:router",
    "root//src/celld/sieve:sieve",
]

# USERS, API_KEYS, SESSION_SECRET and RATE_LIMIT_SECRET are only in each
# spec's `vars`, which reach `.dev.vars` and never the deployed project;
# their values are public examples. A deployment sets its own with
# `celld secret put`; without them each Worker refuses every credential,
# or answers an opaque 500.
celld_example(
    name = "login",
    bindings = {"RATE_LIMITS": "RateLimitShard"},
    main = "login.ts",
    deps = _DEPS,
)

celld_example(
    name = "api",
    bindings = {"RATE_LIMITS": "RateLimitShard"},
    main = "api.ts",
    deps = _DEPS,
)
