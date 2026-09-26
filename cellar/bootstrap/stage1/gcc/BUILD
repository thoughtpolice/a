# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:defs.bzl", "export_file")

# The gperf replacement and the test programs every GCC port shares.
[export_file(name = path) for path in glob([
    "generators/*",
    "tests/*",
    "tests/libstdcxx/*",
])]
