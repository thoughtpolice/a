# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example", "celld_example_upstream")
load("@toolchains//celld:defs.bzl", "celld")

# Each example is a router with sieve bodies around the client.
_DEPS = [
    "root//src/celld/api/jev:jev",
    "root//src/celld/router:router",
    "root//src/celld/sieve:sieve",
]

# A scriptable fake TypeSafe server, shared with other libraries' examples
# (the openai Jev bridge).
celld.library(
    name = "fake",
    import_name = "@celld/api/jev/examples/fake",
    visibility = ["PUBLIC"],
    exports = {".": "fake.ts"},
    deps = ["root//src/celld/api/jev:jev"],
)

# Every example runs against this fake TypeSafe server; see upstream.ts.
celld_example_upstream(
    name = "upstream",
    main = "upstream.ts",
    deps = [":fake"],
)

celld_example(
    name = "triage",
    main = "triage.ts",
    upstream = ":upstream",
    deps = _DEPS,
)

celld_example(
    name = "limited",
    bindings = {"JEV_LIMITER": "JevRateLimiter"},
    kv_namespaces = {"JEV_CACHE": "jev-example-answers"},
    main = "limited.ts",
    upstream = ":upstream",
    deps = _DEPS,
)

celld_example(
    name = "moderation",
    kv_namespaces = {"VERDICTS": "jev-example-verdicts"},
    main = "moderation.ts",
    upstream = ":upstream",
    workflows = [{
        "binding": "MODERATION",
        "class_name": "Moderation",
        "name": "jev-example-moderation",
    }],
    deps = _DEPS,
)

celld_example(
    name = "routing",
    main = "routing.ts",
    upstream = ":upstream",
    deps = _DEPS,
)

celld_example(
    name = "scoring",
    main = "scoring.ts",
    upstream = ":upstream",
    deps = _DEPS,
)
