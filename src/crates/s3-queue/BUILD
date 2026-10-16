# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/chaos3:defs.bzl", "chaos3_local_resource")

SRCS = glob(
    ["*.rs"],
    exclude = ["test_*.rs"],
)

DEPS = [
    "//src/crates/s3-client:s3-client",
    "third-party//rust:async-trait",
    "third-party//rust:bytes",
    "third-party//rust:http-body-util",
    "third-party//rust:hyper",
    "third-party//rust:hyper-util",
    "third-party//rust:reqwest",
    "third-party//rust:serde",
    "third-party//rust:serde_json",
    "third-party//rust:thiserror",
    "third-party//rust:tokio",
    "third-party//rust:tracing",
    "third-party//rust:uuid",
]

TEST_DEPS = DEPS + [
    "third-party//rust:futures",
]

depot.rust_library(
    name = "s3-queue",
    srcs = SRCS,
    crate_root = "lib.rs",
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = TEST_DEPS,
)

# Tests against chaos3, an S3-compatible server process that Buck starts as
# a local resource (see //src/chaos3:defs.bzl). Fault budgets belong to a
# server, so each scenario gets its own server and test target, and
# test_chaos3.rs selects a scenario's tests by the `chaos3_scenario` cfg.
CHAOS3_BUCKET = "s3-queue"

CHAOS3_SCENARIOS = {
    "healthy": {},
    # The broker's third write stalls at the server for three seconds.
    "slow-broker": {
        "failpoints": ["s3.put_object.before=2*off->1*sleep(3000)"],
    },
    # chaos3's adversarial profile, from throttling and delays to errors
    # after writes commit and truncated bodies, across a workload that also
    # crashes the broker. The seed is pinned so the campaign is a
    # regression test; sweep other seeds by hand.
    "storage-v1": {
        "chaos": "storage-v1",
        "chaos_requests": 4000,
        "chaos_trace": True,
        "chaos_warmup_requests": 10,
        "fault_seed": 42,
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
    deps = TEST_DEPS,
) for name in CHAOS3_SCENARIOS]
