# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:host.bzl", "host_python_test")
load(":defs.bzl", "BOOTSTRAP_READ_PATHS", "constraint_setting", "constraint_value", "execution_platform", "platform")

constraint_setting(name = "os")

constraint_value(
    name = "linux",
    setting = ":os",
)

constraint_setting(name = "cpu")

constraint_value(
    name = "amd64",
    setting = ":cpu",
)

# Retained for explicit unsupported branches in the stage0 source inventories.
constraint_value(
    name = "aarch64",
    setting = ":cpu",
)

# The client operating system never changes the bootstrap target ABI.
platform(
    name = "default",
    constraint_values = [
        ":linux",
        ":amd64",
    ],
)

# The parent repository registers this executor next to its own, so cellar
# targets build from either project root.
execution_platform(
    name = "execution",
    platform = ":default",
    sandbox_read_paths = BOOTSTRAP_READ_PATHS,
    visibility = ["PUBLIC"],
)

# Never registered. Tests that run host programs, or that check behavior next
# to the host's own tools, take its executor, which keeps Buck's default
# sandbox read paths.
execution_platform(
    name = "host-tests",
    platform = ":default",
)

# Runs a second Buck daemon in its own isolation directory against the
# standalone project. The native sandbox cannot host that, so sandbox mode
# excludes the label.
host_python_test(
    name = "configuration-test",
    src = "test-platforms.py",
    labels = ["nested-buck"],
)
