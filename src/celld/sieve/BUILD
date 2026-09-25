# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

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
        "root//src/celld/core:core",
        "root//src/celld/sec/jwt:jwt",
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
            "root//src/celld/core:core",
            ":sieve",
        ] + ([
            "root//src/celld/core:core",
            "root//src/celld/sec/jwt:jwt",
        ] if suite == "json_schema" else []),
    )
    for suite in [
        "compose",
        "errors",
        "formats",
        "introspect",
        "json_schema",
        "json_value",
        "limits",
        "modifiers",
        "object",
        "primitives",
        "prototype",
        "standard",
        "string",
        "temporal",
        "types",
    ]
]

# Argument parsing shared by each generated literal-import emitter.
celld.library(
    name = "emit-main",
    import_name = "@celld/sieve/emitter",
    visibility = ["PUBLIC"],
    exports = {".": "tools/emit.ts"},
    deps = [":sieve"],
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
    deps = ["root//src/celld/core:core"],
)
