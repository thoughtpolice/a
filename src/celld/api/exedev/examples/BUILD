# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example", "celld_example_upstream")

_DEPS = [
    "root//src/celld/api/exedev:exedev",
    "root//src/celld/router:router",
    "root//src/celld/sieve:sieve",
]

# Every example runs against this fake lobby, whose VMs run commands through
# a real /bin/sh in the harness's scratch directory; see upstream.ts.
celld_example_upstream(
    name = "upstream",
    main = "upstream.ts",
    run = ["/bin/sh"],
    deps = ["root//src/celld/api/exedev:exedev"],
)

celld_example(
    name = "vms",
    bindings = {"EXE_LIMITER": "ExeKeyLimiter"},
    main = "vms.ts",
    upstream = ":upstream",
    deps = _DEPS,
)

celld_example(
    name = "exec",
    main = "exec.ts",
    upstream = ":upstream",
    deps = _DEPS,
)

celld_example(
    name = "fleet",
    bindings = {"FLEET": "ExeFleet"},
    main = "fleet.ts",
    upstream = ":upstream",
    deps = _DEPS,
)

celld_example(
    name = "provision",
    main = "provision.ts",
    upstream = ":upstream",
    workflows = [{
        "binding": "DEPLOY",
        "class_name": "Deploy",
        "name": "exedev-example-deploy",
    }],
    deps = _DEPS,
)

celld_example(
    name = "gateway",
    main = "gateway.ts",
    upstream = ":upstream",
    deps = _DEPS,
)
