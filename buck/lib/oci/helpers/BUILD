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
    name = "native_binary_layer",
    main = "native_binary_layer.py",
    visibility = ["PUBLIC"],
)

shims.python_binary(
    name = "container_smoke",
    main = "container_smoke.py",
    visibility = ["PUBLIC"],
)

shims.python_binary(
    name = "validate_image",
    main = "validate_image.py",
)

# The test does a plain 'import native_binary_layer', so the module has to land
# at the root of the package rather than under the default base module.
shims.python_library(
    name = "native_binary_layer_lib",
    srcs = ["native_binary_layer.py"],
    base_module = "",
)

shims.python_binary(
    name = "native_binary_layer_test",
    base_module = "",
    main = "native_binary_layer_test.py",
    deps = [":native_binary_layer_lib"],
)

shims.run_test(
    name = "test-native-binary-layer",
    dep = ":native_binary_layer_test",
)
