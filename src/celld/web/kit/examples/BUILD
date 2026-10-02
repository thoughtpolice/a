# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")
load("@toolchains//celld:defs.bzl", "celld")
load("@toolchains//tailwind:defs.bzl", "tailwind")

VIEW_SOURCES = [
    "Page.svelte",
    "draft.svelte.ts",
] + glob(["components/*.svelte"])

celld.library(
    name = "contracts",
    import_name = "@celld/web/fieldnotes/contracts",
    exports = {".": "contract.ts"},
    deps = [
        "root//src/celld/sieve:sieve",
        "root//src/celld/web/router:router",
    ],
)

celld.svelte_library(
    name = "views",
    srcs = VIEW_SOURCES,
    import_name = "@celld/web/fieldnotes/views",
    exports = {
        ".": "Page.svelte",
        "./draft": "draft.svelte.ts",
    },
    deps = [
        "root//src/celld/web/interactions:interactions",
        "root//src/celld/web/kit:kit",
        ":contracts",
    ],
)

celld.library(
    name = "server",
    import_name = "@celld/web/fieldnotes/server",
    exports = {
        ".": "server.ts",
        "./notebook": "notebook.ts",
    },
    deps = [
        "root//src/celld/web/kit:kit",
        "root//src/celld/web/router:router",
        ":contracts",
        ":views",
    ],
)

tailwind.css(
    name = "fieldnotes-styles",
    src = "styles.css",
    srcs = VIEW_SOURCES,
    minify = True,
)

celld.browser(
    name = "browser",
    main = "browser.ts",
    minify = True,
    styles = [":fieldnotes-styles"],
    deps = [
        "root//src/celld/web/kit:kit",
        "root//src/celld/web/router:router",
        ":contracts",
        ":server",
        ":views",
    ],
)

celld_example(
    name = "fieldnotes",
    assets = ":browser",
    assets_binding = "ASSETS",
    assets_run_worker_first = True,
    bindings = {"NOTEBOOK": "Notebook"},
    main = "worker.ts",
    minify = True,
    deps = [":server"],
)
