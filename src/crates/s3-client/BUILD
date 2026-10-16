# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/chaos3:defs.bzl", "chaos3_local_resource")

SRCS = glob(
    ["*.rs"],
    exclude = ["test_*.rs"],
)

DEPS = [
    "third-party//rust:bytes",
    "third-party//rust:chrono",
    "third-party//rust:futures",
    "third-party//rust:hex",
    "third-party//rust:hmac",
    "third-party//rust:percent-encoding",
    "third-party//rust:quick-xml",
    "third-party//rust:reqwest",
    "third-party//rust:serde",
    "third-party//rust:sha2",
    "third-party//rust:thiserror",
    "third-party//rust:tokio",
    "third-party//rust:tracing",
]

depot.rust_library(
    name = "s3-client",
    srcs = SRCS,
    crate_root = "lib.rs",
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = DEPS,
)

# Tests against chaos3, an S3-compatible server process that Buck starts as
# a local resource (see //src/chaos3:defs.bzl). Fault budgets belong to a
# server, so each scenario gets its own server and test target, and
# test_chaos3.rs selects a scenario's tests by the `chaos3_scenario` cfg.
CHAOS3_BUCKET = "s3-client"

CHAOS3_SCENARIOS = {
    "healthy": {},
    "put-after-commit": {
        "failpoints": ["s3.put_object.after_commit=2*return(InternalError)"],
    },
    "body-truncated": {
        "failpoints": ["s3.get_object.body=1*off->1*return(truncate)"],
    },
}

[chaos3_local_resource(
    name = "chaos3-" + name,
    buckets = [CHAOS3_BUCKET],
    **settings
) for name, settings in CHAOS3_SCENARIOS.items()]

[depot.rust_test(
    name = "chaos3-" + name + "-tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    env = {"CHAOS3_BUCKET": CHAOS3_BUCKET},
    local_resources = {"chaos3": ":chaos3-" + name},
    rustc_flags = [
        "--cfg=test_module_chaos3",
        "--cfg=chaos3_scenario=\"{}\"".format(name.replace("-", "_")),
        "--check-cfg=cfg(test, test_module_chaos3)",
        "--check-cfg=cfg(chaos3_scenario, values({}))".format(
            ", ".join(['"{}"'.format(s.replace("-", "_")) for s in CHAOS3_SCENARIOS]),
        ),
        "-Dunexpected_cfgs",
    ],
    deps = DEPS,
) for name in CHAOS3_SCENARIOS]
