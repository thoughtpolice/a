# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/fozzie:defs.bzl", "cxx_fuzz_binary")

depot.cxx_library(
    name = "packet-parser",
    srcs = ["packet.c"],
    exported_headers = ["packet.h"],
)

depot.write_file(
    name = "seed",
    contents = ["FZ1payload"],
)

cxx_fuzz_binary(
    name = "packet-fuzz",
    srcs = ["packet_fuzz.c"],
    corpus = [":seed"],
    duration_seconds = 0,
    jobs = 1,
    runs = 64,
    deps = [":packet-parser"],
)
