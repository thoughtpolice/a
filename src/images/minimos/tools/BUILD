# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# Image-building tools behind the minimos.* macros in ../defs.bzl. Image
# content belongs to the packages that build images, not here.
#
# The Python is stdlib-only, so each tool is a plain python_binary on the
# repository's interpreter, run by the macros with $(exe). common.py holds
# the archive checks the tools share.

depot.python_library(
    name = "common",
    srcs = ["common.py"],
    base_module = "",
    visibility = ["PUBLIC"],
)

depot.python_binary(
    name = "cull",
    base_module = "",
    main = "cull.py",
    visibility = ["PUBLIC"],
    deps = [":common"],
)

depot.python_binary(
    name = "mkapkroot",
    base_module = "",
    main = "mkapkroot.py",
    visibility = ["PUBLIC"],
    deps = [":common"],
)

depot.python_binary(
    name = "mkoverlay",
    base_module = "",
    main = "mkoverlay.py",
    visibility = ["PUBLIC"],
    deps = [":common"],
)

depot.python_binary(
    name = "scratch_image",
    base_module = "",
    main = "scratch_image.py",
    visibility = ["PUBLIC"],
    deps = [":common"],
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

# The tests import the tools as modules, so they land at the root of the
# package rather than under the default base module.
depot.python_library(
    name = "lib",
    srcs = [
        "cull.py",
        "mkapkroot.py",
        "mkoverlay.py",
        "scratch_image.py",
    ],
    base_module = "",
    deps = [":common"],
)

depot.python_binary(
    name = "security-tests",
    base_module = "",
    main = "security_tests.py",
    deps = [":lib"],
)

# The tests read the shipped policy so the adversarial cases can never
# drift from what minimos.image() actually enforces.
depot.run_test(
    name = "test-security",
    args = ["$(location //src/images/minimos:policy.txt)"],
    dep = ":security-tests",
)
