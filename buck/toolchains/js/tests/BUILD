# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@toolchains//deno:defs.bzl", "deno")
load("@toolchains//js:defs.bzl", "js")

js.library(
    name = "tokens",
    import_name = "@fixture/tokens",
    exports = {
        ".": "tokens.js",
        "./long": "long/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.js",
    },
)

js.library(
    name = "plain",
    srcs = ["plain/lazy.js"],
    check_js = True,
    import_name = "@fixture/plain",
    visibility = ["PUBLIC"],
    exports = {
        ".": "plain/index.js",
        "./state": "plain/state.js",
    },
    deps = [":tokens"],
)

js.library(
    name = "typed",
    srcs = [
        "typed/augment.ts",
        "typed/events.ts",
        "typed/lazy.ts",
        "typed/registration.ts",
    ],
    import_name = "@fixture/typed",
    exports = {
        ".": "typed/index.ts",
        "./math": "typed/math.ts",
    },
)

js.library(
    name = "external",
    import_name = "@fixture/external",
    exports = {".": "external.js"},
    deps = ["third-party//js/clsx:library"],
)

js.package(
    name = "external-npm",
    dependencies = {"clsx": "^2.1.1"},
    format = "npm",
    library = ":external",
    version = "1.0.0",
)

js.package(
    name = "external-deno",
    dependencies = {"clsx": "npm:clsx@^2.1.1"},
    format = "deno",
    library = ":external",
    version = "1.0.0",
)

js.library(
    name = "private",
    srcs = ["private/view.tsx"],
    import_name = "@fixture/private",
    exports = {".": "private/api.js"},
)

js.library(
    name = "dependent",
    import_name = "@fixture/dependent",
    exports = {".": "dependent.js"},
    deps = [":private"],
)

js.package(
    name = "dependent-npm",
    dependencies = {"@fixture/private": "1.0.0"},
    format = "npm",
    library = ":dependent",
    version = "1.0.0",
)

shims.export_file(
    name = "private-api",
    src = "private/api.js",
)

js.package(
    name = "tokens-npm",
    format = "npm",
    library = ":tokens",
    version = "1.0.0",
)

js.package(
    name = "plain-npm",
    dependencies = {"@fixture/tokens": "1.0.0"},
    format = "npm",
    library = ":plain",
    version = "1.0.0",
)

js.package(
    name = "typed-npm",
    declarations = True,
    format = "npm",
    library = ":typed",
    version = "1.0.0",
)

js.package(
    name = "tokens-deno",
    format = "deno",
    library = ":tokens",
    version = "1.0.0",
)

js.package(
    name = "plain-deno",
    dependencies = {"@fixture/tokens": "../tokens/"},
    format = "deno",
    library = ":plain",
    version = "1.0.0",
)

js.package(
    name = "typed-deno",
    format = "deno",
    library = ":typed",
    version = "1.0.0",
)

deno.test(
    name = "package-test",
    srcs = ["package_test.ts"],
    data = glob(["typed/*.ts"]),
    env = {
        "PLAIN": "$(location :plain-npm)",
        "TOKENS": "$(location :tokens-npm)",
        "TYPED": "$(location :typed-npm)",
        "DEPENDENT": "$(location :dependent-npm)",
        "PRIVATE": "$(location :private-api)",
    },
    permissions = [
        "read",
        "write",
        "run",
        "env",
    ],
)
