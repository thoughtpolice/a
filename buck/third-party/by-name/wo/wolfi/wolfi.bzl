# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Pinned .apk downloads from the Wolfi package repository.

Wolfi (https://wolfi.dev) is Chainguard's glibc-based rolling
"undistro" built for containers: small packages, fast security
updates, SBOMs for everything. We consume it as plain versioned
.apk files — no apk-tools, no index resolution at build time —
so every input is pinned by (name, version, sha256).

The repository retains historical package versions, so pinned URLs
stay fetchable after new revisions ship. To refresh pins: pick the
new version from the APKINDEX at {repo}/APKINDEX.tar.gz, update the
version and sha256 in BUILD, and let the downstream image boot-smoke
tests gate the bump.
"""

load("@root//buck/shims:shims.bzl", depot = "shims")

# x86_64 only for now — matches the linux/amd64 images minimos emits.
WOLFI_REPO = "https://packages.wolfi.dev/os/x86_64"

def wolfi_apk(package, version, sha256, visibility = ["PUBLIC"]):
    """One pinned Wolfi package, exposed as `<package>.apk`."""
    depot.http_file(
        name = package + ".apk",
        sha256 = sha256,
        urls = ["{}/{}-{}.apk".format(WOLFI_REPO, package, version)],
        visibility = visibility,
    )

def wolfi_apks(pins):
    """Declare a `<package>.apk` target for every {package: (version, sha256)} pin."""
    for package, (version, sha256) in pins.items():
        wolfi_apk(package, version, sha256)
