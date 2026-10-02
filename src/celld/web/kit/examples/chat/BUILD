# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")
load("@toolchains//celld:defs.bzl", "celld")
load("@toolchains//tailwind:defs.bzl", "tailwind")

VIEW_SOURCES = [
    "Page.svelte",
    "chat.svelte.ts",
    "model.ts",
] + glob(["components/*.svelte"])

celld.library(
    name = "contracts",
    import_name = "@celld/web/switchboard/contracts",
    exports = {".": "contract.ts"},
    deps = [
        "root//src/celld/sieve:sieve",
        "root//src/celld/web/realtime:realtime",
        "root//src/celld/web/router:router",
    ],
)

celld.svelte_library(
    name = "views",
    srcs = VIEW_SOURCES,
    import_name = "@celld/web/switchboard/views",
    exports = {
        ".": "Page.svelte",
        "./model": "model.ts",
    },
    deps = [
        "root//src/celld/web/interactions:interactions",
        "root//src/celld/web/kit:kit",
        "root//src/celld/web/realtime:realtime",
        "root//src/celld/web/router:router",
        ":contracts",
    ],
)

celld.library(
    name = "server",
    import_name = "@celld/web/switchboard/server",
    exports = {
        ".": "server.ts",
        "./rooms": "rooms.ts",
    },
    deps = [
        "root//src/celld/sieve:sieve",
        "root//src/celld/web/kit:kit",
        "root//src/celld/web/realtime:realtime",
        "root//src/celld/web/router:router",
        ":contracts",
        ":views",
    ],
)

tailwind.css(
    name = "styles",
    src = "styles.css",
    srcs = VIEW_SOURCES,
    css_srcs = ["root//src/celld/web/ui:ui.css"],
    minify = True,
)

celld.browser(
    name = "browser",
    main = "browser.ts",
    minify = True,
    styles = [":styles"],
    deps = [
        "root//src/celld/web/kit:kit",
        ":contracts",
        ":views",
    ],
)

celld_example(
    name = "switchboard",
    assets = ":browser",
    assets_binding = "ASSETS",
    assets_run_worker_first = True,
    bindings = {
        "ROOMS": "ChatRoom",
        "DIRECTORY": "ChannelDirectory",
    },
    main = "worker.ts",
    minify = True,
    deps = [":server"],
)

celld.test(
    name = "runtime-test",
    srcs = [
        "runtime_test.ts",
        "switchboard.json",
    ],
    env = {
        "CELLD": "$(exe toolchains//celld:cli)",
        "PROJECT": "$(location :switchboard)",
    },
    permissions = [
        "env",
        "net=127.0.0.1",
        "read",
        "run",
        "write",
    ],
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/web/realtime:realtime",
        "root//src/celld/web/realtime/examples:dev-server",
        ":contracts",
    ],
)
