# SPDX-FileCopyrightText: © 2024-2026 Benjamin Brittain
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/lib/tar:defs.bzl", "tar_file")
load("@root//buck/shims:shims.bzl", "shims")

# Test tar_file with prefix
tar_file(
    name = "test_with_prefix",
    srcs = ["test_with_prefix.txt"],
    compress = True,
    prefix = "usr/local/bin",
)

# Verify the prefix works correctly
shims.command_test(
    name = "test_verify_prefix",
    cmd = [
        "bash",
        "-c",
        "tar tzf $(location :test_with_prefix) | grep -q 'usr/local/bin/test_with_prefix.txt'",
    ],
)
