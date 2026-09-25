# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")

# Every example runs a real container (the pinned busybox image in
# ../image), so their tests need a Docker engine: `needs-docker`.
celld_example(
    name = "web",
    bindings = {"WEB": "Web"},
    container_context = "root//src/celld/container/image:image",
    containers = [{
        "class_name": "Web",
        "image": "container/Dockerfile",
        "instance_type": "dev",
        "max_instances": 1,
    }],
    labels = ["needs-docker"],
    main = "web.ts",
    deps = ["root//src/celld/container:container"],
)
