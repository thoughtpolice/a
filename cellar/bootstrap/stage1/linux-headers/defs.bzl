# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# The top-level directories of the installed headers, which an installation
# merges into the C library's include directory. install.sh fails if the
# kernel installs any others.
DIRECTORIES = [
    "asm",
    "asm-generic",
    "cxl",
    "drm",
    "fwctl",
    "linux",
    "misc",
    "mtd",
    "rdma",
    "regulator",
    "scsi",
    "sound",
    "video",
    "xen",
]
