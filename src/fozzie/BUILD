# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.test_suite(
    name = "tests",
    tests = [
        "root//src/fozzie/engine:all-tests",
        "root//src/fozzie/examples/cxx:packet-fuzz",
        "root//src/fozzie/examples/rust:decoder-fuzz",
        "root//src/fozzie/runtime:tests",
    ],
    visibility = ["PUBLIC"],
)

# Keep sanitizer execution opt-in while allowing builders without an ASan
# runtime to validate the ordinary Fozzie suite. This target still analyzes the
# public transitions and materializes both instrumented final binaries.
depot.filegroup(
    name = "asan-builds",
    srcs = [
        "root//src/fozzie/examples/cxx:packet-fuzz-asan",
        "root//src/fozzie/examples/rust:decoder-fuzz-asan",
    ],
    visibility = ["PUBLIC"],
)

depot.test_suite(
    name = "asan-tests",
    tests = [
        "root//src/fozzie/examples/cxx:packet-fuzz-asan",
        "root//src/fozzie/examples/rust:decoder-fuzz-asan",
    ],
    visibility = ["PUBLIC"],
)
