# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@root//src/celld/examples:defs.bzl", "celld_example")
load("@root//src/celld/sieve:defs.bzl", "sieve_json_schema")
load("@toolchains//celld:defs.bzl", "celld")

celld_example(
    name = "signup",
    kv_namespaces = {"USERS": "sieve-example-users"},
    main = "signup.ts",
    deps = [
        "root//src/celld/sieve:sieve",
        "root//src/celld/ulid:ulid",
    ],
)

celld_example(
    name = "webhooks",
    main = "webhooks.ts",
    deps = ["root//src/celld/sieve:sieve"],
)

celld_example(
    name = "search",
    main = "search.ts",
    deps = ["root//src/celld/sieve:sieve"],
)

# The schemas of the `schema` example's API, as a library of their own so
# the Worker and the build-time export read the same module.
celld.library(
    name = "api",
    import_name = "@sieve-example/api",
    exports = {".": "api.ts"},
    deps = ["root//src/celld/sieve:sieve"],
)

# api-schema.json: every named schema in `@sieve-example/api`.
sieve_json_schema(
    name = "api-schema",
    module = "@sieve-example/api",
    deps = [":api"],
)

# The project's static assets: the schema file at /schema.json.
shims.filegroup(
    name = "schema-assets",
    srcs = {"schema.json": ":api-schema"},
)

celld_example(
    name = "schema",
    assets = ":schema-assets",
    assets_binding = "ASSETS",
    main = "schema.ts",
    deps = [
        "root//src/celld/sieve:sieve",
        ":api",
    ],
)

celld_example(
    name = "tokens",
    main = "tokens.ts",
    deps = [
        "root//src/celld/jwt:jwt",
        "root//src/celld/sieve:sieve",
        "root//src/celld/ulid:ulid",
    ],
)
