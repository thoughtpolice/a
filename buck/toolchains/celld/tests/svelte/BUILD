# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

celld.svelte_library(
    name = "page",
    srcs = [
        "state.svelte.ts",
        "types.ts",
    ],
    import_name = "@celld/web/kit-test-page",
    visibility = ["PUBLIC"],
    exports = {".": "TestPage.svelte"},
    deps = [
        "root//src/celld/web/interactions:interactions",
        "root//src/celld/web/kit:kit",
    ],
)

celld.library(
    name = "contract",
    import_name = "@celld/web/kit-test-contract",
    visibility = ["PUBLIC"],
    exports = {".": "contract.ts"},
    deps = [
        "root//src/celld/sieve:sieve",
        "root//src/celld/web/router:router",
    ],
)

celld.browser(
    name = "browser",
    main = "browser.ts",
    minify = True,
    deps = [
        "root//src/celld/web/kit:kit",
        "root//src/celld/web/router:router",
        ":contract",
        ":page",
    ],
)

celld.worker(
    name = "worker",
    main = "worker.ts",
    minify = True,
    deps = [
        "root//src/celld/web/kit:kit",
        "root//src/celld/web/router:router",
        ":contract",
        ":page",
    ],
)

celld.project(
    name = "hydration-project",
    src = ":worker",
    assets = ":browser",
    assets_binding = "ASSETS",
    assets_run_worker_first = True,
    script_name = "celld-native-hydration-test",
)

celld.deploy_test(
    name = "deploy-test",
    project = ":hydration-project",
)
