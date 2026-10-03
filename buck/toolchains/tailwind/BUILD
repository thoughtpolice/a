# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@toolchains//python-bootstrap:defs.bzl", "simple_exe_download")

TAILWIND_VERSION = "4.3.3"

# SHA-256 digests from the official release metadata:
# https://api.github.com/repos/tailwindlabs/tailwindcss/releases/tags/v4.3.3
TAILWIND_RELEASES = {
    "linux-x64": "dc61b3ac6b8c9ca874c0cc4c57b2409791a64c5540404ca5f5367360babc313a",
    "linux-arm64": "55fd0b241214eff3de1e8ee4f22796662f2d2e7a49bcfca7477cfd0bac398195",
    "macos-x64": "7922e0953f2110c05976e3bf58f14e643d90427575e766b7d433f5f80cbee7e1",
    "macos-arm64": "cdf646702987a743464dff4d9c60fd4480d1c1e73dd819a9a67f1078815dce9d",
}

[
    simple_exe_download(
        name = "release-" + platform,
        sha256 = sha256,
        url = "https://github.com/tailwindlabs/tailwindcss/releases/download/v{}/tailwindcss-{}".format(TAILWIND_VERSION, platform),
    )
    for platform, sha256 in TAILWIND_RELEASES.items()
]

# tailwind.css uses this alias as an exec_dep, so the selection follows the
# execution platform. Unsupported hosts fail selection rather than using PATH.
shims.alias(
    name = "compiler",
    actual = shims.select({
        "config//cpu:arm64": shims.select({
            "config//os:linux": ":release-linux-arm64",
            "config//os:macos": ":release-macos-arm64",
        }),
        "config//cpu:x86_64": shims.select({
            "config//os:linux": ":release-linux-x64",
            "config//os:macos": ":release-macos-x64",
        }),
    }),
)

shims.python_binary(
    name = "runner",
    main = "runner.py",
)

shims.python_binary(
    name = "compiler-test-runner",
    main = "compiler_test.py",
)

shims.command_test(
    name = "compiler-test",
    cmd = [
        "$(exe :compiler-test-runner)",
        "$(exe :runner)",
        "$(location :compiler)",
    ],
)
