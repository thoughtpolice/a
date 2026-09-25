# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example", "celld_example_upstream")

# Every example serves its routes with @celld/router and checks its request
# bodies with @celld/sieve.
_DEPS = [
    "root//src/celld/api/openai:openai",
    "root//src/celld/router:router",
    "root//src/celld/sieve:sieve",
]

# Every example runs against this fake LLM integration, which also serves
# the jev examples' fake TypeSafe for the bridge; see upstream.ts.
celld_example_upstream(
    name = "upstream",
    main = "upstream.ts",
    deps = [
        "root//src/celld/api/jev/examples:fake",
        "root//src/celld/api/openai:openai",
    ],
)

celld_example(
    name = "chat",
    main = "chat.ts",
    upstream = ":upstream",
    deps = _DEPS,
)

celld_example(
    name = "extract",
    main = "extract.ts",
    upstream = ":upstream",
    deps = _DEPS,
)

celld_example(
    name = "agent",
    main = "agent.ts",
    upstream = ":upstream",
    deps = _DEPS,
)

celld_example(
    name = "review",
    main = "review.ts",
    upstream = ":upstream",
    deps = _DEPS,
)

celld_example(
    name = "threads",
    bindings = {
        "GPT_CONVERSATIONS": "GptConversations",
        "GPT_PACER": "GptPacer",
    },
    main = "threads.ts",
    upstream = ":upstream",
    deps = _DEPS,
)

celld_example(
    name = "bridge",
    main = "bridge.ts",
    upstream = ":upstream",
    deps = _DEPS + [
        "root//src/celld/api/jev:jev",
        "root//src/celld/api/openai:jev-bridge",
    ],
)

# The sandbox bridge over a real container (the pinned busybox image of
# //src/celld/container/image), so its tests need a Docker engine.
celld_example(
    name = "sandbox",
    bindings = {"ANALYZER": "Analyzer"},
    container_context = "root//src/celld/container/image:image",
    containers = [{
        "class_name": "Analyzer",
        "image": "container/Dockerfile",
        "instance_type": "dev",
        "max_instances": 2,
    }],
    labels = ["needs-docker"],
    main = "sandbox.ts",
    upstream = ":upstream",
    deps = _DEPS + [
        "root//src/celld/api/openai:sandbox-bridge",
        "root//src/celld/sandbox:sandbox",
    ],
)
