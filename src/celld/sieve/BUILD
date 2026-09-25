# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//celld:defs.bzl", "celld")
load(":defs.bzl", "sieve_json_schema")

# The core is `@celld/sieve`; JSON Schema export and definition walking are
# subpaths the core never imports, so a Worker that only parses does not
# carry them. The string formats for addresses, dates and times, ULIDs and
# JWTs come from their own libraries, so sieve accepts what they parse.
celld.library(
    name = "sieve",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/sieve",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./introspect": "src/introspect.ts",
        "./json-schema": "src/json_schema.ts",
    },
    deps = [
        "root//src/celld/ip:ip",
        "root//src/celld/isotime:isotime",
        "root//src/celld/jwt:jwt",
        "root//src/celld/ulid:ulid",
    ],
)

# One suite per concern; `types` fails `deno check` when inference regresses.
# `json_schema` compares its patterns with the libraries' own.
[
    celld.test(
        name = "{}-test".format(suite),
        srcs = [
            "tests/fixture.ts",
            "tests/{}_test.ts".format(suite),
        ],
        deps = [
            "root//src/celld/assert:assert",
            ":sieve",
        ] + ([
            "root//src/celld/ip:ip",
            "root//src/celld/jwt:jwt",
            "root//src/celld/ulid:ulid",
        ] if suite == "json_schema" else []),
    )
    for suite in [
        "compose",
        "errors",
        "formats",
        "introspect",
        "json_schema",
        "json_value",
        "modifiers",
        "object",
        "primitives",
        "standard",
        "string",
        "temporal",
        "types",
    ]
]

# The emitter `sieve_json_schema` runs; see defs.bzl.
depot.export_file(
    name = "emit-main",
    src = "tools/emit.ts",
    mode = "reference",
    visibility = ["PUBLIC"],
)

# An API module for the golden test below.
celld.library(
    name = "fixture-api",
    import_name = "@sieve-fixture/api",
    exports = {".": "tests/fixture_api.ts"},
    deps = [":sieve"],
)

sieve_json_schema(
    name = "fixture-api-schema",
    module = "@sieve-fixture/api",
    deps = [":fixture-api"],
)

# Builds the bundle above and compares it with the checked-in golden file;
# after an intended change, copy the built file over the golden one.
celld.test(
    name = "emit-test",
    srcs = ["tests/emit_test.ts"],
    data = ["tests/golden/fixture-api.schema.json"],
    env = {
        "SIEVE_EMITTED": "$(location :fixture-api-schema)",
        "SIEVE_GOLDEN": "src/celld/sieve/tests/golden/fixture-api.schema.json",
    },
    permissions = [
        "env",
        "read",
    ],
    deps = ["root//src/celld/assert:assert"],
)
