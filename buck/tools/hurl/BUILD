# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "download_hurl")

HURL_VERSION = "8.0.1"

# SHA-256 of the tar.gz assets in the official release metadata:
# https://api.github.com/repos/Orange-OpenSource/hurl/releases/tags/8.0.1
HURL_RELEASES = {
    "aarch64-apple-darwin": "b57928e246617df73cb1b2157f31f507dcbde6ae12e828cc53dde0e40e05bbbb",
    "aarch64-unknown-linux-gnu": "bc4732df4754748e9bf296aa3832ec019f798afb399f1279b72ed37b6e04525c",
    "x86_64-apple-darwin": "55e95bb7a8d61ae6919eaaf96f260f0836f5b34c1b0f7731e38be803f6984367",
    "x86_64-unknown-linux-gnu": "cac7c4670d69444db120edb21fe06c97ba8c80dcc52279957c8dd18f05fb0c06",
}

[
    download_hurl(
        name = "{}-{}".format(HURL_VERSION, triple),
        sha256 = sha256,
        triple = triple,
        version = HURL_VERSION,
    )
    for triple, sha256 in HURL_RELEASES.items()
]

# Unsupported operating systems/architectures fail selection explicitly.
shims.alias(
    name = "hurl",
    actual = shims.select({
        "config//cpu:arm64": shims.select({
            "config//os:linux": ":{}-aarch64-unknown-linux-gnu".format(HURL_VERSION),
            "config//os:macos": ":{}-aarch64-apple-darwin".format(HURL_VERSION),
        }),
        "config//cpu:x86_64": shims.select({
            "config//os:linux": ":{}-x86_64-unknown-linux-gnu".format(HURL_VERSION),
            "config//os:macos": ":{}-x86_64-apple-darwin".format(HURL_VERSION),
        }),
    }),
    tests = [":version-check"],
)

# Executing --version also catches missing runtime libraries on the test host.
shims.filecheck.test(
    name = "version-check",
    args = ["--version"],
    check = "root//buck/tools/hurl/tests:version-check-source",
    defines = {"VERSION": HURL_VERSION},
    dep = ":hurl",
)
