# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")

celld_example(
    name = "selfcheck",
    main = "selfcheck.ts",
    vars = {"TAX_RATE": "0.2"},
    deps = ["root//src/celld/assert:assert"],
)

# The same Worker deployed with a percentage where a rate belongs.
celld_example(
    name = "selfcheck-misconfigured",
    main = "selfcheck.ts",
    spec = "selfcheck_misconfigured.json",
    vars = {"TAX_RATE": "20"},
    deps = ["root//src/celld/assert:assert"],
)

celld_example(
    name = "drift",
    kv_namespaces = {"DESIRED": "assert-example-desired"},
    main = "drift.ts",
    deps = ["root//src/celld/assert:assert"],
)
