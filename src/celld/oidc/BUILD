# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//celld:defs.bzl", "celld")

# One library, one subpath per role, like @celld/oauth: a relying party
# never bundles the provider or the federation code.
celld.library(
    name = "oidc",
    srcs = glob(["src/**/*.ts"]),
    import_name = "@celld/oidc",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./broker": "src/broker/mod.ts",
        "./federation": "src/federation/mod.ts",
        "./provider": "src/provider/mod.ts",
        "./rp": "src/rp/mod.ts",
        "./testing": "src/testing.ts",
    },
    deps = [
        "root//src/celld/jwt:jwt",
        "root//src/celld/oauth:oauth",
    ],
)

# One suite per concern. `idtoken` checks OpenID Connect Core's appendix A
# examples; `policy` and `chain` the Federation specification's; `flow`
# runs relying parties, providers, federations and a broker against each
# other in one process.
[
    celld.test(
        name = "{}-test".format(suite),
        srcs = [
            "tests/federation_fixture.ts",
            "tests/fixture.ts",
            "tests/vectors.ts",
            "tests/{}_test.ts".format(suite),
        ],
        deps = [
            "root//src/celld/assert:assert",
            "root//src/celld/jwt:jwt",
            "root//src/celld/oauth:oauth",
            ":oidc",
        ],
    )
    for suite in [
        "core",
        "flow",
        "idtoken",
        "chain",
        "policy",
        "provider",
        "rp",
    ]
]

# A Worker serving a provider and a federation, with their records in
# @celld/oauth's OAuthRecords Durable Object, for the runtime test below.
celld.worker(
    name = "runtime-worker",
    main = "tests/runtime/worker.ts",
    deps = [
        "root//src/celld/oauth:oauth",
        ":oidc",
    ],
)

celld.project(
    name = "runtime-project",
    src = ":runtime-worker",
    bindings = {"OAUTH_RECORDS": "OAuthRecords"},
    script_name = "oidc-runtime-test",
)

celld.deploy_test(
    name = "deploy-test",
    project = ":runtime-project",
)

depot.python_binary(
    name = "runtime-test-runner",
    main = "tests/runtime_test.py",
)

# Runs the project under `celld dev` and drives it over loopback HTTP,
# restarting the supervisor to check what must be durable; no network.
depot.command_test(
    name = "runtime-test",
    cmd = [
        "$(exe :runtime-test-runner)",
        "$(exe toolchains//celld:cli)",
        "$(location :runtime-project)",
    ],
)
