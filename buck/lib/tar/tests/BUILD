# SPDX-FileCopyrightText: © 2024-2026 Benjamin Brittain
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/lib/tar:defs.bzl", "tar_file")
load("@root//buck/shims:shims.bzl", "shims")

shims.export_file(
    name = "test_with_prefix.txt",
    src = "test_with_prefix.txt",
)

tar_file(
    name = "test_with_prefix_a",
    srcs = [":test_with_prefix.txt"],
    compress = True,
    prefix = "usr/local/bin",
)

tar_file(
    name = "test_with_prefix_b",
    srcs = [":test_with_prefix.txt"],
    compress = True,
    prefix = "usr/local/bin",
)

shims.python_bootstrap_binary(
    name = "verify_tar",
    main = "verify_tar.py",
)

shims.run_test(
    name = "test_tar",
    args = [
        "$(location :test_with_prefix_a)",
        "$(location :test_with_prefix_b)",
        "$(location :test_with_prefix.txt)",
    ],
    dep = ":verify_tar",
)
