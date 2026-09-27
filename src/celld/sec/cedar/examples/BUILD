# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")

# API_KEYS is only in each spec's `vars`, which reach `.dev.vars` and never
# the deployed project; its values are public example keys. A deployment
# sets its own with `celld secret put`, and each Worker refuses every key
# while it is unset.
celld_example(
    name = "docs",
    bindings = {"WORKSPACE": "Workspace"},
    main = "docs.ts",
    deps = [
        "root//src/celld/sec/cedar:cedar",
        "root//src/celld/sieve:sieve",
        "root//src/celld/web/router:router",
    ],
)

celld_example(
    name = "gate",
    main = "gate.ts",
    deps = [
        "root//src/celld/sec/cedar:cedar",
        "root//src/celld/sieve:sieve",
        "root//src/celld/web/router:router",
    ],
)
