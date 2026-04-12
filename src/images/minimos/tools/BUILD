# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# Generic image-building machinery consumed by the minimos.* macros in
# ../defs.bzl. Nothing minimos-specific lives here — image content is
# declared by the packages that build images.
#
# The Python is stdlib-only — no uv/pyelftools/etc, so we skip
# uv.python_binary and just surface the scripts via export_file; the
# macros spell out the python3 invocation explicitly.

depot.export_file(
    name = "cull.py",
    src = "cull.py",
    visibility = ["PUBLIC"],
)

depot.export_file(
    name = "scratch_image.py",
    src = "scratch_image.py",
    visibility = ["PUBLIC"],
)

depot.export_file(
    name = "mkoverlay.py",
    src = "mkoverlay.py",
    visibility = ["PUBLIC"],
)

depot.export_file(
    name = "mkapkroot.py",
    src = "mkapkroot.py",
    visibility = ["PUBLIC"],
)

depot.export_file(
    name = "extract_one.py",
    src = "extract_one.py",
    visibility = ["PUBLIC"],
)

depot.export_file(
    name = "unpack_and_cull.sh",
    src = "unpack_and_cull.sh",
    mode = "reference",
    visibility = ["PUBLIC"],
)

depot.export_file(
    name = "assemble_and_cull.sh",
    src = "assemble_and_cull.sh",
    mode = "reference",
    visibility = ["PUBLIC"],
)

depot.export_file(
    name = "boot_smoke.sh",
    src = "boot_smoke.sh",
    mode = "reference",
    visibility = ["PUBLIC"],
)

python_bootstrap_binary(
    name = "security-tests",
    main = "security_tests.py",
)

depot.run_test(
    name = "test-security",
    args = [
        "$(location :mkapkroot.py)",
        "$(location :cull.py)",
        "$(location :mkoverlay.py)",
        "$(location :scratch_image.py)",
        "$(location :extract_one.py)",
        "$(location //src/images/minimos:defs.bzl)",
    ],
    dep = ":security-tests",
)
