# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# Deno resolves a module's imports relative to the file on disk, so the sources
# stay in the package that declares the rules; an export_file into another
# package would copy each file alone and break every relative import.
ENTRIES = [
    "browser.ts",
    "headless.ts",
    "serve.ts",
    "worklet.ts",
]

CORE = glob(
    ["*.ts"],
    exclude = ENTRIES + ["*_test.ts"],
)

# The page loads the worklet by URL rather than importing it, so the two
# bundles are separate: an AudioWorklet runs on its own thread with no DOM.
depot.deno.bundle(
    name = "console",
    srcs = CORE,
    config = "deno.jsonc",
    main = "browser.ts",
    platform = "browser",
    visibility = ["PUBLIC"],
)

depot.deno.bundle(
    name = "worklet",
    srcs = ["sink_buffer.ts"],
    config = "deno.jsonc",
    main = "worklet.ts",
    platform = "browser",
    visibility = ["PUBLIC"],
)

depot.deno.run(
    name = "headless",
    src = "headless.ts",
    srcs = CORE + ["mirror_dir.ts"],
    check = True,
    config = "deno.jsonc",
    permissions = [
        "read",
        "write",
    ],
    visibility = ["PUBLIC"],
)

depot.deno.run(
    name = "serve",
    src = "serve.ts",
    check = True,
    config = "deno.jsonc",
    permissions = [
        "net",
        "read",
    ],
    visibility = ["PUBLIC"],
)

depot.deno.test(
    name = "tests",
    srcs = glob(["test/*_test.ts"]),
    config = "deno.jsonc",
    # The modules the tests import, and the WIT the key names are checked
    # against: named so the test's inputs are complete.
    data = CORE + ENTRIES + ["//aseipp/wlink/demo/sdk:sdk.wit"],
    env = {
        "CONSOLE_WEB_CONTRACT_WASM": "$(location //aseipp/wlink/demo:sdk-contract-linked.wasm)",
        "CONSOLE_WEB_GAME_WASM": "$(location //aseipp/wlink/demo:linked.wasm)",
        "CONSOLE_WEB_IWAD": "$(location //aseipp/wlink/demo/doom:freedoom[freedoom2.wad])",
    },
    permissions = [
        "read",
        "write",
        "env",
    ],
)

# The repository's formatter does not know TypeScript; run
# `deno fmt --config tilde/aseipp/wlink/demo/sdk/web/deno.jsonc <files>` after
# editing and this keeps it honest.
depot.deno.fmt_check(
    name = "fmt",
    srcs = glob([
        "*.ts",
        "test/*.ts",
        "*.jsonc",
    ]),
    config = "deno.jsonc",
)

[
    depot.export_file(
        name = name,
        src = name,
        visibility = ["PUBLIC"],
    )
    for name in [
        "index.html",
        "web_package.py",
    ]
]

depot.export_file(
    name = "web_package_test.py",
    src = "web_package_test.py",
)

depot.command_test(
    name = "test-web-package-tool",
    cmd = [
        "python3",
        "$(location :web_package_test.py)",
        "$(location :web_package.py)",
    ],
)
