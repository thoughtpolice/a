# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "celld", "celld_project_tool", "celld_toolchain", "download_celld")

CELLD_VERSION = "0.6.1"

PROJECT_SRCS = [
    "project/config.go",
    "project/discover.go",
    "project/main.go",
    "project/proxy.go",
]

# Upstream publishes these three host binaries; unsupported platforms fail selection.
# SHA-256 digests of the compressed .gz assets from the official release metadata:
# https://api.github.com/repos/denoland/celld/releases/tags/v0.6.1
CELLD_RELEASES = {
    "aarch64-unknown-linux-gnu": "ab99053bcced225bb5b54f428792260c905b782b8a61947362a12ce3a9c22def",
    "x86_64-unknown-linux-gnu": "79a8253cff5d4e8a4a9f7a2611e393390f7fe9025f00e88467875b007c44866b",
    "aarch64-apple-darwin": "3033cc4f428433f4239ac616a04092cd4b6c7db19f2f5ba9926c86ec56c34c95",
}

shims.export_file(
    name = "gunzip",
    src = "gunzip.sh",
)

# Keep the source path visible to TypeScript configs and reference directives.
shims.export_file(
    name = "types",
    src = "types/celld.d.ts",
    mode = "reference",
)

# The fake `cloudflare:*` modules that `celld.test(fake_runtime = True)` maps
# in, one file per declared platform module.
shims.export_file(
    name = "testing",
    src = "testing",
    mode = "reference",
)

[
    shims.export_file(
        name = "testing-{}".format(module),
        src = "testing/{}.ts".format(module),
        mode = "reference",
    )
    for module in [
        "sockets",
        "workers",
        "workflows",
    ]
]

# The Deno language server behind a proxy that feeds it the celld units'
# import maps; see project/main.go. Editors run it through
# buck/bin/celld-project.
shims.go_binary(
    name = "celld-project",
    srcs = PROJECT_SRCS,
    cgo_enabled = False,
    link_mode = "internal",
    tests = [
        ":celld-project-lsp-test",
        ":celld-project-test",
    ],
)

shims.go_test(
    name = "celld-project-test",
    srcs = PROJECT_SRCS + ["project/proxy_test.go"],
    cgo_enabled = False,
)

# The proxy in front of the real `deno lsp`, over the fixture units' fragments.
shims.go_test(
    name = "celld-project-lsp-test",
    srcs = PROJECT_SRCS + ["project/lsp_test.go"],
    cgo_enabled = False,
    env = {
        "CELLD_DENO": "$(exe toolchains//web:deno)",
        "CELLD_FRAGMENTS": " ".join([
            "$(location toolchains//celld/tests/lib:{}[ide])".format(unit)
            for unit in [
                "base",
                "objects",
                "objects-test",
                "top",
                "top-test",
                "worker",
            ]
        ]),
    },
)

# `celld-project` with the toolchain's Deno: `buck2 run
# toolchains//celld:project -- lsp`. Arguments other than `lsp` go to Deno.
celld_project_tool(
    name = "project",
    proxy = ":celld-project",
    visibility = ["PUBLIC"],
)

# One release binary per platform, named by triple alone so that consumers
# (`toolchains//celld:release-<triple>[archive]`) do not change with the pin.
[
    download_celld(
        name = "release-{}".format(triple),
        sha256 = sha256,
        triple = triple,
        version = CELLD_VERSION,
    )
    for triple, sha256 in CELLD_RELEASES.items()
]

celld_toolchain(
    name = "celld-{}".format(CELLD_VERSION),
    celld = shims.select({
        "config//cpu:arm64": shims.select({
            "config//os:linux": ":release-aarch64-unknown-linux-gnu",
            "config//os:macos": ":release-aarch64-apple-darwin",
        }),
        "config//cpu:x86_64": shims.select({
            "config//os:linux": ":release-x86_64-unknown-linux-gnu",
        }),
    }),
)

shims.toolchain_alias(
    name = "celld",
    actual = ":celld-{}".format(CELLD_VERSION),
)

celld.binary(
    name = "cli",
    tests = [":version-check"],
)

shims.filecheck.test(
    name = "version-check",
    args = ["--version"],
    check = "version.check",
    defines = {"VERSION": CELLD_VERSION},
    dep = ":cli",
)
