# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load(":defs.bzl", "mems3_hurl_test")

HTTP_CASES = [
    "buckets",
    "checksums",
    "copy-delete",
    "listings",
    "multipart",
    "objects",
    "preconditions",
    "ranges",
    "signed",
    "unsupported",
]

SRCS = [
    "chaos.rs",
    "faults.rs",
    "main.rs",
    "memory.rs",
]

DEPS = [
    "root//src/crates/faultline:faultline",
    "third-party//by-name/mi/mimalloc:rust",
    "third-party//rust:async-trait",
    "third-party//rust:bytes",
    "third-party//rust:hex",
    "third-party//rust:http-body-util",
    "third-party//rust:hyper-util",
    "third-party//rust:percent-encoding",
    "third-party//rust:s3s",
    "third-party//rust:tokio",
]

depot.rust_binary(
    name = "mems3",
    srcs = SRCS,
    tests = [
        "tilde//aseipp/mems3/resource:test",
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
        "third-party//rust:futures",
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
        "$(exe :mems3)",
    ],
)

depot.filecheck.lit(
    name = "cli-output-test",
    srcs = ["tests/cli.test"],
    tools = {"mems3": ":mems3"},
)

# Each scenario mutates its server, so each gets a private one: Buck keys
# local resource pools by target label and holds an entry for a whole test.
[
    mems3_hurl_test(
        name = "hurl-{}".format(case),
        src = "tests/hurl/{}.hurl".format(case),
        file_root = "tilde//aseipp/mems3/tests/fixtures:fixtures",
    )
    for case in HTTP_CASES
]

depot.test_suite(
    name = "http-tests",
    tests = [":hurl-{}".format(case) for case in HTTP_CASES] + [
        ":hurl-buggify",
        ":hurl-faults",
    ],
)

mems3_hurl_test(
    name = "hurl-faults",
    src = "tests/hurl/faults.hurl",
    failpoints = [
        "s3.get_object.before=2*return(SlowDown)",
        "s3.put_object.after_commit=1*return(InternalError)",
        "s3.delete_object.after_commit=1*return(ServiceUnavailable)",
    ],
    fault_seed = 42,
)

mems3_hurl_test(
    name = "hurl-buggify",
    src = "tests/hurl/buggify.hurl",
    buggify = True,
    buggify_activation = 100,
    buggify_firing = 100,
    fault_seed = 42,
)
