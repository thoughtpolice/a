# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:host.bzl", "host_python_test")
load(":defs.bzl", "BOOTSTRAP_READ_PATHS", "constraint_setting", "constraint_value", "execution_platform", "execution_platforms", "platform", "platform_transition")

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

constraint_value(
    name = "arm64",
    setting = ":cpu",
)

platform(
    name = "linux-arm64",
    constraint_values = [
        ":linux",
        ":arm64",
    ],
)

platform_transition(
    name = "to-amd64",
    platform = ":default",
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
    name = "execution-amd64",
    platform = ":default",
    sandbox_read_paths = BOOTSTRAP_READ_PATHS,
    visibility = ["PUBLIC"],
)

execution_platform(
    name = "execution-arm64",
    cpu = "arm64",
    platform = ":linux-arm64",
    sandbox_read_paths = BOOTSTRAP_READ_PATHS,
)

execution_platforms(
    name = "execution",
    platforms = [
        ":execution-amd64",
        ":execution-arm64",
    ],
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
