# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# OCI image manipulation helpers

shims.python_binary(
    name = "oci_pull",
    main = "oci_pull.py",
    visibility = ["PUBLIC"],
)

shims.python_binary(
    name = "oci_image",
    main = "oci_image.py",
    visibility = ["PUBLIC"],
)

shims.python_binary(
    name = "oci_unpack",
    main = "oci_unpack.py",
    visibility = ["PUBLIC"],
)

shims.python_binary(
    name = "oci_repack",
    main = "oci_repack.py",
    visibility = ["PUBLIC"],
)

shims.python_binary(
    name = "oci_index",
    main = "oci_index.py",
    visibility = ["PUBLIC"],
)

shims.python_binary(
    name = "validate_image",
    main = "validate_image.py",
)
