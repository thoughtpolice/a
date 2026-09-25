# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")

celld_example(
    name = "reminders",
    bindings = {"REMINDERS": "Reminders"},
    main = "reminders.ts",
    deps = [
        "root//src/celld/isotime:isotime",
        "root//src/celld/ulid:ulid",
    ],
)

celld_example(
    name = "durations",
    main = "durations.ts",
    deps = ["root//src/celld/isotime:isotime"],
)

celld_example(
    name = "convert",
    main = "convert.ts",
    deps = ["root//src/celld/isotime:isotime"],
)

celld_example(
    name = "ttl",
    bindings = {"STORE": "Store"},
    main = "ttl.ts",
    vars = {"DEFAULT_TTL": "P1D"},
    deps = ["root//src/celld/isotime:isotime"],
)
