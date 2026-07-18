# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Hermetic Go toolchain, built on the upstream prelude's Go toolchain rules.

Downloads official Go distributions from go.dev and wires them into the
prelude's go_toolchain/go_bootstrap_toolchain pair, which the prelude's
go_binary/go_library/go_test rules expect to find at toolchains//:go and
toolchains//:go_bootstrap.
"""

load(
    "@prelude//toolchains/go:go_bootstrap_toolchain.bzl",
    "go_bootstrap_distr",
    "go_bootstrap_toolchain",
)
load("@prelude//toolchains/go:go_toolchain.bzl", "go_distr", "go_toolchain")

_GOOS_CONSTRAINTS = {
    "darwin": "config//os:macos",
    "linux": "config//os:linux",
    "windows": "config//os:windows",
}

_GOARCH_CONSTRAINTS = {
    "amd64": "config//cpu:x86_64",
    "arm64": "config//cpu:arm64",
}

def _distr_select(hashes: list[(str, str)], f):
    """Nested os/cpu select over the downloaded distributions, mapping each
    triple to f(goos, goarch). These resolve in the exec configuration: the
    distribution must run on the machine executing compile actions."""
    by_os = {}
    for triple, _ in hashes:
        goos, goarch = triple.split("-")
        by_os.setdefault(_GOOS_CONSTRAINTS[goos], {})[_GOARCH_CONSTRAINTS[goarch]] = f(goos, goarch)
    return select({os: select(cpus) for os, cpus in by_os.items()})

def hermetic_go_toolchain(version: str, hashes: list[(str, str)]):
    """Download the official Go distribution for the given version and declare
    matching `:go-{version}` and `:go_bootstrap-{version}` toolchains."""
    for triple, sha256 in hashes:
        ext = "zip" if triple.startswith("windows") else "tar.gz"
        native.http_archive(
            name = "{version}-{triple}".format(version = version, triple = triple),
            sha256 = sha256,
            strip_prefix = "go",
            type = ext,
            urls = ["https://go.dev/dl/go{version}.{triple}.{ext}".format(version = version, triple = triple, ext = ext)],
            visibility = [],
        )

    go_os_arch = _distr_select(hashes, lambda goos, goarch: (goos, goarch))
    go_root = _distr_select(hashes, lambda goos, goarch: ":{version}-{goos}-{goarch}".format(version = version, goos = goos, goarch = goarch))

    # GOOS/GOARCH the toolchain emits code for; unlike the distribution
    # selects above, these resolve in the target configuration
    env_go_os = select({constraint: goos for goos, constraint in _GOOS_CONSTRAINTS.items()})
    env_go_arch = select({constraint: goarch for goarch, constraint in _GOARCH_CONSTRAINTS.items()})

    go_bootstrap_distr(
        name = "go_bootstrap_distr-{version}".format(version = version),
        go_os_arch = go_os_arch,
        go_root = go_root,
    )

    go_bootstrap_toolchain(
        name = "go_bootstrap-{version}".format(version = version),
        env_go_arch = env_go_arch,
        env_go_os = env_go_os,
        go_bootstrap_distr = ":go_bootstrap_distr-{version}".format(version = version),
    )

    go_distr(
        name = "go_distr-{version}".format(version = version),
        go_os_arch = go_os_arch,
        go_root = go_root,
        version = version,
    )

    go_toolchain(
        name = "go-{version}".format(version = version),
        env_go_arch = env_go_arch,
        env_go_os = env_go_os,
        go_distr = ":go_distr-{version}".format(version = version),
    )
