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

depot.write_file(
    name = "json-seed",
    contents = ['{"name": "fozzie", "id": 42, "tags": ["a", "b"], "nested": {"x": 1.5e3, "ok": true, "none": null}, "s": "caf\\u00e9"}'],
)

# A round-trip oracle for serde_json, which kermit's JSON and tree mutators
# suit. The dictionary supplies JSON's tokens and escapes from the start, before the
# comparison operands fill the dynamic dictionary.
rust_fuzz_binary(
    name = "json-fuzz",
    srcs = ["json_fuzz.rs"],
    corpus = [":json-seed"],
    dictionaries = ["json.dict"],
    duration_seconds = 0,
    jobs = 1,
    runs = 64,
    deps = ["third-party//rust:serde_json"],
)
