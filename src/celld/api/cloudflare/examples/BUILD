# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example", "celld_example_upstream")

_DEPS = [
    "root//src/celld/api/cloudflare:cloudflare",
    "root//src/celld/web/router:router",
    "root//src/celld/sieve:sieve",
]

# Every example runs against this fake Cloudflare (the API and siteverify
# on one origin, with a zone and a Turnstile widget); see upstream.ts.
celld_example_upstream(
    name = "upstream",
    main = "upstream.ts",
    deps = ["root//src/celld/api/cloudflare:cloudflare"],
)

celld_example(
    name = "signup",
    bindings = {"WAITLIST": "Waitlist"},
    main = "signup.ts",
    upstream = ":upstream",
    deps = _DEPS,
)

celld_example(
    name = "admin",
    main = "admin.ts",
    upstream = ":upstream",
    deps = _DEPS,
)
