# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/fozzie:defs.bzl", "rust_fuzz_binary")

depot.rust_library(
    name = "decoder",
    srcs = ["decoder.rs"],
    crate_root = "decoder.rs",
)

depot.write_file(
    name = "seed",
    contents = ["FZ1payload"],
)

rust_fuzz_binary(
    name = "decoder-fuzz",
    srcs = ["decoder_fuzz.rs"],
    corpus = [":seed"],
    duration_seconds = 0,
    jobs = 1,
    runs = 64,
    deps = [":decoder"],
)

rust_fuzz_binary(
    name = "decoder-fuzz-asan",
    srcs = ["decoder_fuzz.rs"],
    corpus = [":seed"],
    duration_seconds = 0,
    jobs = 1,
    runs = 16,
    sanitizer = "address",
    visibility = ["PUBLIC"],
    deps = [":decoder"],
)
