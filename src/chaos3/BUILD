# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load(":defs.bzl", "chaos3_hurl_test")

FIXTURES = "root//src/chaos3/tests/fixtures:fixtures"

# One Hurl scenario per entry, with the settings its server needs. Each
# scenario mutates its server, so each gets a private resource target. defs.bzl
# explains why a shared one would not isolate them. Only scenarios that send
# `file,` bodies depend on the generated fixtures.
HTTP_CASES = {
    "buckets": {},
    "checksums": {},
    "copy-delete": {},
    "faults": {
        "failpoints": [
            "s3.get_object.before=2*return(SlowDown)",
            "s3.put_object.after_commit=1*return(InternalError)",
            "s3.delete_object.after_commit=1*return(ServiceUnavailable)",
        ],
        "fault_seed": 42,
    },
    "listings": {},
    "multipart": {"file_root": FIXTURES},
    "objects": {"file_root": FIXTURES},
    "preconditions": {},
    "ranges": {"file_root": FIXTURES},
    "signed": {},
    "unsupported": {},
}

SRCS = [
    "chaos.rs",
    "faults.rs",
    "handlers.rs",
    "main.rs",
    "memory.rs",
]

DEPS = [
    "root//src/crates/faultline:faultline",
    "third-party//by-name/mi/mimalloc:rust",
    "third-party//rust:async-trait",
    "third-party//rust:bytes",
    "third-party//rust:futures",
    "third-party//rust:hex",
    "third-party//rust:http-body-util",
    "third-party//rust:hyper-util",
    "third-party//rust:percent-encoding",
    "third-party//rust:s3s",
    "third-party//rust:tokio",
]

depot.rust_binary(
    name = "chaos3",
    srcs = SRCS,
    tests = [
        "root//src/chaos3/resource:test",
        ":cli-output-test",
        ":cli-test",
        ":http-tests",
        ":test",
    ],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "test",
    srcs = SRCS + glob(["tests/*_test.rs"]),
    crate_root = "main.rs",
    deps = DEPS + [
        "third-party//rust:http",
        "third-party//rust:quick-xml",
    ],
)

depot.python_binary(
    name = "cli-test-exe",
    main = "tests/cli_test.py",
)

depot.command_test(
    name = "cli-test",
    cmd = [
        "$(exe :cli-test-exe)",
        "$(exe :chaos3)",
    ],
)

depot.filecheck.lit(
    name = "cli-output-test",
    srcs = ["tests/cli.test"],
    tools = {"chaos3": ":chaos3"},
)

[
    chaos3_hurl_test(
        name = "hurl-{}".format(case),
        src = "tests/hurl/{}.hurl".format(case),
        **settings
    )
    for case, settings in HTTP_CASES.items()
]

depot.test_suite(
    name = "http-tests",
    tests = [":hurl-{}".format(case) for case in HTTP_CASES],
)
