# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# The one program behind every rule in buck/lib/oci and buck/lib/tar. It
# needs only Go's standard library and golang.org/x.
shims.go_binary(
    name = "oci",
    srcs = glob(
        ["*.go"],
        exclude = ["*_test.go"],
    ),
    tests = [":unit"],
    visibility = ["PUBLIC"],
)

shims.go_test(
    name = "unit",
    srcs = glob(["*.go"]),
    env = {
        "PATCHELF": "$(exe third-party//by-name/pa/patchelf:patchelf)",
    },
)
