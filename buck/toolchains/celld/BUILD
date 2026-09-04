# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "celld", "celld_project_tool", "celld_tool", "celld_toolchain", "download_celld")

CELLD_VERSION = "0.5.1"

PROJECT_SRCS = [
    "project/config.go",
    "project/discover.go",
    "project/main.go",
    "project/proxy.go",
]

# Upstream publishes these three host binaries; unsupported platforms fail selection.
# SHA-256 digests of the compressed .gz assets from the official release metadata:
# https://api.github.com/repos/denoland/celld/releases/tags/v0.5.1
CELLD_RELEASES = {
    "aarch64-unknown-linux-gnu": "375c7cd9446d61e6ee2c263d6be792650153ffd7cd562b2c4b6b644776b4494e",
    "x86_64-unknown-linux-gnu": "b9f205da7365ef4a8b2e16f1f48065a8ddd5cda366edc258fea12a097d8ab4b7",
    "aarch64-apple-darwin": "f330823e049e64276ca7133957f4d50897cf8f5d34e7a53f621b2bfe63994861",
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

# The fake "cloudflare:workers" that `celld.test(fake_runtime = True)` maps in.
shims.export_file(
    name = "testing",
    src = "testing/workers.ts",
    mode = "reference",
)

# Writes Deno configs, checks import graphs, and runs Deno for every
# celld.library, celld.test and celld.worker; see celldc.py.
shims.python_binary(
    name = "celldc",
    main = "celldc.py",
)

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
        "CELLD_DENO": "$(exe :deno)",
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

# The driver and Deno as the toolchain configures them, for its own tests.
celld_tool(
    name = "driver",
    tool = "celldc",
    visibility = ["toolchains//celld/..."],
)

celld_tool(
    name = "deno",
    tool = "deno",
    visibility = ["toolchains//celld/..."],
)

[
    download_celld(
        name = "{}-{}".format(CELLD_VERSION, triple),
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
            "config//os:linux": ":{}-aarch64-unknown-linux-gnu".format(CELLD_VERSION),
            "config//os:macos": ":{}-aarch64-apple-darwin".format(CELLD_VERSION),
        }),
        "config//cpu:x86_64": shims.select({
            "config//os:linux": ":{}-x86_64-unknown-linux-gnu".format(CELLD_VERSION),
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
