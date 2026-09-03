# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""The browser host's sources, named for the rules here and in `sdk:defs.bzl`.

A test in another package imports the core by its path in the repository, so
`console_web_test` has to name every file the core is made of, which a glob in
this package cannot do for it."""

# The programs: each is a bundle or a `deno run` of its own.
WEB_ENTRIES = [
    "browser.ts",
    "headless.ts",
    "serve.ts",
    "terminal.ts",
    "worklet.ts",
]

# Everything the entries import.
WEB_CORE = [
    "abi.ts",
    "assert.ts",
    "audio.ts",
    "canvas2d.ts",
    "dump.ts",
    "files.ts",
    "fixtures.ts",
    "gpu.ts",
    "hal.ts",
    "hal_bindings.ts",
    "hash.ts",
    "input.ts",
    "keys.ts",
    "manifest.ts",
    "mirror_dir.ts",
    "render.ts",
    "runner.ts",
    "sink_buffer.ts",
    "storage.ts",
    "tty.ts",
]
