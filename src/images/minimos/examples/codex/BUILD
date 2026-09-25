# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/images/minimos:defs.bzl", "minimos")

# minimos + Codex: the dev machine's layers plus OpenAI's Codex CLI, set
# up for exe.dev's ChatGPT integration. A VM for one coding agent:
#
#   ssh exe.dev new --image=<pushed image> --integration=chatgpt --name=agent
#   ssh agent.exe.xyz codex exec 'say hello'
#
# The chatgpt integration is what lets the VM reach the endpoint in
# ~/.codex/config.toml. A tag of the same name doesn't.

_DEV = "//src/images/minimos/examples/dev"

_CODEX_VERSION = "0.155.1"

# The release tarball holds a single static musl binary named after the
# target triple; the overlay installs it as `codex`.
_CODEX_BINARY = "codex-x86_64-unknown-linux-musl"

# The Codex CLI (Apache-2.0, © OpenAI) as the static musl binary from the
# upstream GitHub release, hash-pinned like every other input. Upstream
# tags CLI releases rust-v<version>.
depot.http_archive(
    name = "codex",
    sha256 = "a0ef8b2debc3bf747e07b1a039354de31300ac0dcc2276498ba281470b5d9115",
    sub_targets = [_CODEX_BINARY],
    type = "tar.gz",
    urls = [
        "https://github.com/openai/codex/releases/download/rust-v{}/{}.tar.gz"
            .format(_CODEX_VERSION, _CODEX_BINARY),
    ],
)

# The base has no /usr/local, so this layer declares the directories.
minimos.overlay(
    name = "codex-overlay-layer",
    dirs = [
        "usr/local",
        "usr/local/bin",
        "home/exedev/.codex:700:1000:1000",
    ],
    files = {
        "usr/local/bin/codex": ":codex[{}]:755".format(_CODEX_BINARY),
        "home/exedev/.codex/config.toml": "config.toml:600:1000:1000",
    },
)

minimos.image(
    name = "minimos-codex",
    boot_smoke_dev = True,
    boot_smoke_units = ["user@1000.service"],
    boot_smoke_userland = True,
    description = "minimos dev machine + the Codex CLI coding agent",
    layers = [
        "{}:user-manager-culled-layer".format(_DEV),
        "{}:dev-tools-culled-layer".format(_DEV),
        "{}:dev-overlay-layer".format(_DEV),
        ":codex-overlay-layer",
    ],
    version = "0.1.0",
    visibility = ["PUBLIC"],
)
