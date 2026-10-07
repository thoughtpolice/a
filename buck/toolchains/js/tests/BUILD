# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

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
