# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")
load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "dev-server",
    import_name = "@celld/examples/dev-server",
    visibility = ["PUBLIC"],
    exports = {".": "dev_server.ts"},
)

# API_KEYS is only in the spec's `vars`, which reach `.dev.vars` and never
# the deployed project; its keys are public examples. A deployment sets its
# own with `celld secret put`, and the Worker refuses every key while it is
# unset.
celld_example(
    name = "chat",
    bindings = {"ROOMS": "ChatRoom"},
    main = "chat.ts",
    deps = [
        "root//src/celld/sieve:sieve",
        "root//src/celld/web/realtime:realtime",
        "root//src/celld/web/router:router",
    ],
)

# The WebSocket half of `chat`, which the harness's HTTP specs cannot
# drive: RoomClients against the packaged project under `celld dev`, on
# loopback only.
celld.test(
    name = "chat-runtime-test",
    srcs = [
        "chat.json",
        "chat_runtime_test.ts",
        "dev_server.ts",
    ],
    env = {
        "CELLD": "$(exe toolchains//celld:cli)",
        "PROJECT": "$(location :chat)",
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
    ],
)
