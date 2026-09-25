# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")

celld_example(
    name = "mint",
    main = "mint.ts",
    deps = ["root//src/celld/ulid:ulid"],
)

celld_example(
    name = "events",
    bindings = {"EVENTS": "EventLog"},
    main = "events.ts",
    deps = ["root//src/celld/ulid:ulid"],
)

celld_example(
    name = "convert",
    kv_namespaces = {"ITEMS": "ulid-example-items"},
    main = "convert.ts",
    deps = ["root//src/celld/ulid:ulid"],
)
