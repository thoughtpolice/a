# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")
load("@toolchains//celld:defs.bzl", "celld")

# Every example runs a real container (the pinned busybox image of
# //src/celld/box/container/image), so their tests need a Docker engine and are
# labelled `needs-docker`.
_CONTAINER = {
    "container_context": "root//src/celld/box/container/image:image",
    "labels": ["needs-docker"],
}

# Secrets and development switches live in the specs' `vars` (written only
# to `.dev.vars`), never here: `vars` in this file ships in the project.
# `runner` and `jobs` need `AUTH_SECRET` for the bearer tokens of `auth.ts`
# (the specs carry a development secret and tokens minted with it); a
# deployment sets its own as a secret. Without it every call fails (`auth.ts`
# fails closed).

# `Runner` is the production class (tier "hostile"): a deployment declares
# it with "runtime": "runsc" and binds only it. This development host cannot
# run runsc, so the example also binds `UnsafeTrustedRunner`, and
# `runner.json` opts into it with UNSAFE_RUNNER_ON_RUNC in its `vars`; its
# answers say "trusted (unsafe)". `runner-hostile` is the same project with
# a spec that does not set the variable: the hostile class refuses runc.
_RUNNER = dict(
    srcs = ["auth.ts"],
    bindings = {
        "RUNNER": "Runner",
        "UNSAFE_TRUSTED_RUNNER": "UnsafeTrustedRunner",
    },
    containers = [
        {
            "class_name": name,
            "image": "container/Dockerfile",
            "instance_type": "dev",
            "max_instances": 2,
        }
        for name in [
            "Runner",
            "UnsafeTrustedRunner",
        ]
    ],
    main = "runner.ts",
    deps = [
        "root//src/celld/box/sandbox:sandbox",
        "root//src/celld/core:core",
        "root//src/celld/sieve:sieve",
    ],
    **_CONTAINER
)

celld_example(
    name = "runner",
    **_RUNNER
)

celld_example(
    name = "runner-hostile",
    spec = "runner-hostile.json",
    **_RUNNER
)

celld_example(
    name = "jobs",
    srcs = ["auth.ts"],
    bindings = {
        "CI": "Ci",
        "UNSAFE_TRUSTED_CI": "UnsafeTrustedCi",
    },
    containers = [{
        "class_name": name,
        "image": "container/Dockerfile",
        "instance_type": "dev",
        "max_instances": 2,
    } for name in [
        "Ci",
        "UnsafeTrustedCi",
    ]],
    main = "jobs.ts",
    deps = [
        "root//src/celld/box/sandbox:sandbox",
        "root//src/celld/core:core",
        "root//src/celld/sieve:sieve",
    ],
    **_CONTAINER
)

# Production-policy refusal test: only the hostile CI binding is present.
celld_example(
    name = "jobs-hostile",
    srcs = ["auth.ts"],
    bindings = {"CI": "Ci"},
    containers = [{
        "class_name": "Ci",
        "image": "container/Dockerfile",
        "instance_type": "dev",
        "max_instances": 2,
    }],
    main = "jobs.ts",
    spec = "jobs-hostile.json",
    deps = [
        "root//src/celld/box/sandbox:sandbox",
        "root//src/celld/core:core",
        "root//src/celld/sieve:sieve",
    ],
    **_CONTAINER
)

# UNAUTHENTICATED demo: anyone who can reach this Worker can read,
# overwrite, list and delete every file in its one shared sandbox and keep
# the container running. Never deploy it. `workspace.json` lowers the PUT
# cap (MAX_FILE_BYTES) so the spec can cross it.
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
    deps = [
        "root//src/celld/box/sandbox:sandbox",
        "root//src/celld/core:core",
    ],
    **_CONTAINER
)

# UNAUTHENTICATED demo: anyone who can reach this Worker can start and stop
# the dev server and obtain its preview token (and so the preview URL).
# Never deploy it. Preview URLs are https unless PREVIEW_PROTOCOL says
# otherwise; `devserver.json` sets "http" for the loopback test.
celld_example(
    name = "devserver",
    bindings = {"DEV": "Dev"},
    containers = [{
        "class_name": "Dev",
        "image": "container/Dockerfile",
        "instance_type": "dev",
        "max_instances": 2,
    }],
    srcs = ["httpd.ts"],
    main = "devserver.ts",
    vars = {"PREVIEW_HOST": "preview.localhost"},
    deps = ["root//src/celld/box/sandbox:sandbox"],
    **_CONTAINER
)

# Concurrent `POST /start`s, which the spec's one-at-a-time steps cannot
# send: exactly one httpd may start. No container: a stand-in answers.
celld.test(
    name = "devserver_race-test",
    srcs = [
        "devserver_race_test.ts",
        "httpd.ts",
    ],
    deps = [
        "root//src/celld/box/sandbox:sandbox",
        "root//src/celld/core:core",
    ],
)

celld.test(
    name = "auth-test",
    srcs = [
        "auth.ts",
        "auth_test.ts",
    ],
    deps = [
        "root//src/celld/box/sandbox:sandbox",
        "root//src/celld/core:core",
    ],
)
