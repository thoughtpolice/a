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

# Both archives come from the same input, so they must be byte for byte the
# same, and hold one normalized file under the prefix.
shims.command_test(
    name = "test_tar",
    script = """
        a="$(location :test_with_prefix_a)"
        b="$(location :test_with_prefix_b)"
        src="$(location :test_with_prefix.txt)"

        cmp "$a" "$b"
        test "`tar -tzf "$a"`" = usr/local/bin/test_with_prefix.txt
        tar -xzOf "$a" usr/local/bin/test_with_prefix.txt | cmp - "$src"
        TZ=UTC tar --numeric-owner -tvzf "$a" | grep -q '^-rw-r--r-- 0/0 .* 1970-01-01 00:00 usr/local/bin/test_with_prefix.txt$'
    """,
)
