# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/images/minimos:defs.bzl", "minimos")

# --------------------------------------------------------------------------
# minimos + Codex: the dev-machine layers (coreutils, git, user
# manager) with OpenAI's Codex CLI overlaid on PATH, preconfigured for
# exe.dev's ChatGPT integration. This is the "dedicated coding agent
# session" composition:
#
#   ssh exe.dev new --image=<pushed image> --integration=chatgpt --name=agent
#   ssh agent.exe.xyz codex exec 'say hello'
#
# The named integration lets the VM reach the proxied endpoint baked into
# ~/.codex/config.toml; tags and integrations are separate exe.dev features.
# --------------------------------------------------------------------------

_DEV = "//src/images/minimos/examples/dev"

_TOOLS = "//src/images/minimos/tools"

_CODEX_VERSION = "0.144.6"

# The Codex CLI (Apache-2.0, © OpenAI), consumed as the prebuilt
# static musl binary from the upstream GitHub release — hash-pinned
# like every other input, no npm involved. Upstream tags CLI releases
# as rust-v<version>.
depot.http_file(
    name = "codex-x86_64-unknown-linux-musl.tar.gz",
    sha256 = "6a9def51a0ad8cea6684d8eb3bf033c89f33e3bc5cfe492f1a1e0a718451a1c6",
    urls = [
        "https://github.com/openai/codex/releases/download/rust-v{}/codex-x86_64-unknown-linux-musl.tar.gz"
            .format(_CODEX_VERSION),
    ],
)

# The release tarball holds a single static musl binary named after the
# target triple; pull it out so the overlay can install it as `codex`.
depot.genrule(
    name = "codex-bin",
    out = "codex",
    cmd = " ".join([
        "python3",
        "$(location {}:extract_one.py)".format(_TOOLS),
        "$(location :codex-x86_64-unknown-linux-musl.tar.gz)",
        "codex-x86_64-unknown-linux-musl",
        "$OUT",
    ]),
)

# mkoverlay.py is driven directly here instead of via minimos.overlay:
# the binary is a build artifact, which the macro's files= (source
# paths only) can't express. The base has no /usr/local at all, so the
# layer carries the whole directory chain.
depot.genrule(
    name = "codex-overlay-layer",
    srcs = ["config.toml"],
    out = "codex-overlay-layer.tar",
    cmd = " ".join([
        "python3",
        "$(location {}:mkoverlay.py)".format(_TOOLS),
        "--out $OUT",
        "--dir usr/local",
        "--dir usr/local/bin",
        "--dir home/exedev/.codex:700:1000:1000",
        "--file $(location :codex-bin):usr/local/bin/codex:755",
        "--file config.toml:home/exedev/.codex/config.toml:600:1000:1000",
    ]),
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
