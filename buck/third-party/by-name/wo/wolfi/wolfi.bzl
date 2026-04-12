# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Pinned .apk downloads from the Wolfi package repository.

Wolfi (https://wolfi.dev) is Chainguard's glibc-based rolling
"undistro" built for containers: small packages, fast security
updates, SBOMs for everything. We consume it as plain versioned
.apk files — no apk-tools, no index resolution at build time —
so every input is pinned by (name, version, sha256).

The repository retains historical package versions, so pinned URLs
stay fetchable after new revisions ship. Refresh every pin from the
repository's APKINDEX, hashing only packages whose version changed:

    buck2 run third-party//by-name/wo/wolfi:update

Use ``-- --check`` to report available versions without downloading
package bodies or changing BUILD. The updater follows the newest
publication timestamp in the repository, including an intentional
rollback, and trusts its HTTPS transport (it does not independently
verify the index signature). Downstream image boot-smoke tests gate the
resulting bump.
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
