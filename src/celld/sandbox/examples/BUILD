# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")

# Every example runs a real container (the pinned busybox image of
# //src/celld/container/image), so their tests need a Docker engine and are
# labelled `needs-docker`.
_CONTAINER = {
    "container_context": "root//src/celld/container/image:image",
    "labels": ["needs-docker"],
}

celld_example(
    name = "runner",
    bindings = {"RUNNER": "Runner"},
    containers = [{
        "class_name": "Runner",
        "image": "container/Dockerfile",
        "instance_type": "dev",
        "max_instances": 2,
    }],
    main = "runner.ts",
    deps = [
        "root//src/celld/sandbox:sandbox",
        "root//src/celld/sieve:sieve",
    ],
    **_CONTAINER
)

celld_example(
    name = "jobs",
    bindings = {"CI": "Ci"},
    containers = [{
        "class_name": "Ci",
        "image": "container/Dockerfile",
        "instance_type": "dev",
        "max_instances": 2,
    }],
    main = "jobs.ts",
    deps = [
        "root//src/celld/sandbox:sandbox",
        "root//src/celld/sieve:sieve",
    ],
    **_CONTAINER
)

celld_example(
    name = "workspace",
    bindings = {"WORKSPACE": "Workspace"},
    containers = [{
        "class_name": "Workspace",
        "image": "container/Dockerfile",
        "instance_type": "dev",
        "max_instances": 2,
    }],
    main = "workspace.ts",
    deps = ["root//src/celld/sandbox:sandbox"],
    **_CONTAINER
)

celld_example(
    name = "devserver",
    bindings = {"DEV": "Dev"},
    containers = [{
        "class_name": "Dev",
        "image": "container/Dockerfile",
        "instance_type": "dev",
        "max_instances": 2,
    }],
    main = "devserver.ts",
    vars = {"PREVIEW_HOST": "preview.localhost"},
    deps = ["root//src/celld/sandbox:sandbox"],
    **_CONTAINER
)
