# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/chaos3:defs.bzl", "chaos3_local_resource")

DEPS = [
    "third-party//rust:async-trait",
    "third-party//rust:bytes",
    "third-party//rust:chrono",
    "third-party//rust:futures",
    "third-party//rust:hex",
    "third-party//rust:hmac",
    "third-party//rust:object_store",
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
    name = "s3-store",
    srcs = glob(["*.rs"]),
    visibility = ["//src/tools/cache-server/..."],
    deps = DEPS,
)

TEST_DEPS = DEPS + [
    "third-party//rust:hyper",
    "third-party//rust:hyper-util",
    "third-party//rust:s3s",
    "third-party//rust:slatedb",
]

TEST_MODULES = {
    "sigv4": {},
    "xml": {},
    "store": {},
    "slatedb": {},
}

# Per-module test targets
[depot.rust_test(
    name = "tests-" + name,
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    rustc_flags = ["--cfg=test_module_" + name],
    deps = TEST_DEPS,
) for name in TEST_MODULES]

# All-in-one target
depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    rustc_flags = ["--cfg=test_module_" + name for name in TEST_MODULES],
    deps = TEST_DEPS,
)

# Tests against chaos3, an S3-compatible server process that Buck starts as
# a local resource (see //src/chaos3:defs.bzl). Each scenario gets its own
# server and test target: fault budgets belong to a server, and Buck may run
# the tests of one target against the same server in turn. test_chaos3.rs
# selects a scenario's tests by the `chaos3_scenario` cfg.
CHAOS3_BUCKET = "s3-store"

COMPLETE_FAILS_AFTER_COMMIT = "s3.complete_multipart_upload.after_commit=1*return(InternalError)"

TRUNCATE_FIRST_BODY = "s3.get_object.body=1*off->1*return(truncate)"

CHAOS3_SCENARIOS = {
    "healthy": {},
    "put-after-commit": {
        "failpoints": ["s3.put_object.after_commit=2*return(InternalError)"],
    },
    "complete-after-commit": {"failpoints": [COMPLETE_FAILS_AFTER_COMMIT]},
    "transient": {
        "failpoints": [
            "s3.put_object.before=2*return(SlowDown)",
            "s3.get_object.before=2*return(SlowDown)",
        ],
    },
    # Every fourth PutObject commit answers 500, five times over.
    "slatedb-commit-errors": {
        "failpoints": ["s3.put_object.after_commit=" + "->".join(
            ["3*off->1*return(InternalError)"] * 5,
        )],
    },
    "body-truncated": {"failpoints": [TRUNCATE_FIRST_BODY]},
    "body-truncated-object-changed": {"failpoints": [TRUNCATE_FIRST_BODY]},
    # SlateDB writes SSTs over 10 MiB by multipart upload, tagged with its
    # put ID; the first completion takes effect but answers 500.
    "slatedb-multipart-commit-error": {"failpoints": [COMPLETE_FAILS_AFTER_COMMIT]},
    # chaos3's adversarial profile: throttling, errors after commit, delays,
    # and truncated GET bodies across a SlateDB workload. The seed is pinned
    # so the campaign is a regression test; sweep other seeds by hand.
    "slatedb-storage-v1": {
        "chaos": "storage-v1",
        "chaos_requests": 2000,
        "chaos_trace": True,
        "chaos_warmup_requests": 20,
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
        # Reject a scenario name test_chaos3.rs spells differently.
        "--check-cfg=cfg({})".format(", ".join([
            "test",
            "test_module_chaos3",
        ] + ["test_module_" + m for m in TEST_MODULES])),
        "--check-cfg=cfg(chaos3_scenario, values({}))".format(
            ", ".join(['"{}"'.format(s.replace("-", "_")) for s in CHAOS3_SCENARIOS]),
        ),
        "-Dunexpected_cfgs",
    ],
    deps = TEST_DEPS,
) for name in CHAOS3_SCENARIOS]
