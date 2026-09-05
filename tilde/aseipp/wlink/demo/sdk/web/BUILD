# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load(":sources.bzl", CORE = "WEB_CORE", ENTRIES = "WEB_ENTRIES")

# The sources are listed in sources.bzl for `console_web_test`, so a file added
# here and not there fails to load rather than going missing from a test's
# inputs.
_LISTED = CORE + ENTRIES

_SOURCES = glob(
    ["*.ts"],
    exclude = ["*_test.ts"],
)

_UNLISTED = [name for name in _SOURCES if name not in _LISTED]

_MISSING = [name for name in _LISTED if name not in _SOURCES]

_UNLISTED and fail("add to sources.bzl: " + " ".join(_UNLISTED))

_MISSING and fail("remove from sources.bzl: " + " ".join(_MISSING))

# Deno resolves a module's imports relative to the file on disk, so the sources
# stay in the package that declares the rules, and a copy of one file in
# another package would break every relative import. The core and its
# configuration are exported where they are (`reference`) instead, for
# `console_web_test`, whose tests import them by their repository path.
[
    depot.export_file(
        name = name,
        src = name,
        mode = "reference",
        visibility = ["PUBLIC"],
    )
    for name in CORE + ["deno.jsonc"]
]

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

# `terminal.ts`: a linked application in a terminal, for the ones the
# native runner cannot translate (a gameplayc game keeps its state on the
# garbage-collected heap, which wasm2c does not have).
depot.deno.run(
    name = "terminal",
    src = "terminal.ts",
    srcs = CORE + ["mirror_dir.ts"],
    check = True,
    config = "deno.jsonc",
    permissions = [
        "env",
        "read",
        "run",
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

# hal_bindings.ts is witgen's TypeScript for the HAL's host side, checked in
# because Deno resolves an import beside the file that makes it; this keeps it
# what witgen writes.
depot.command_test(
    name = "test-hal-bindings",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
fresh="${TMPDIR:-/tmp}/hal_bindings.$$.ts"
trap 'rm -f "$fresh"' EXIT
$(exe tilde//aseipp/witgen:witgen) host $(location //aseipp/wlink/demo/sdk:sdk.wit) \\
  $(location //aseipp/wlink/demo/sdk:hal.wit) --world platform --lang ts --strict -o "$fresh"
if ! cmp -s "$fresh" $(location :hal_bindings.ts); then
  echo "web/hal_bindings.ts is out of date; regenerate it:" >&2
  echo "  buck2 run tilde//aseipp/witgen:witgen -- host tilde/aseipp/wlink/demo/sdk/wit/sdk.wit tilde/aseipp/wlink/demo/sdk/wit/hal.wit --world platform --lang ts -o tilde/aseipp/wlink/demo/sdk/web/hal_bindings.ts" >&2
  diff -u $(location :hal_bindings.ts) "$fresh" >&2 || true
  exit 1
fi
""",
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
