# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")

celld_example(
    name = "reminders",
    bindings = {"REMINDERS": "Reminders"},
    main = "reminders.ts",
    deps = [
        "root//src/celld/core:core",
    ],
)

celld_example(
    name = "durations",
    main = "durations.ts",
    deps = [
        "root//src/celld/core:core",
    ],
)

celld_example(
    name = "convert",
    main = "convert.ts",
    deps = [
        "root//src/celld/core:core",
    ],
)

celld_example(
    name = "ttl",
    bindings = {"STORE": "Store"},
    main = "ttl.ts",
    vars = {
        "DEFAULT_TTL": "P1D",
        "MAX_ENTRIES": "10000",
    },
    deps = [
        "root//src/celld/core:core",
    ],
)

# The same Worker with a DEFAULT_TTL that is not a duration, which must fail
# closed.
celld_example(
    name = "ttl-misconfigured",
    bindings = {"STORE": "Store"},
    main = "ttl.ts",
    spec = "ttl_misconfigured.json",
    vars = {
        "DEFAULT_TTL": "P1D",
        "MAX_ENTRIES": "10000",
    },
    deps = [
        "root//src/celld/core:core",
    ],
)
