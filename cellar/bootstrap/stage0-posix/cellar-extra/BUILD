# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Custom tools that are NOT from upstream stage0-posix. These are compiled with
# M2-Mesoplanet just like mescc-tools-extra, but live in a separate directory to
# make it clear they are cellar-specific additions.

load("@cellar//bootstrap/stage0-posix/mescc-tools-extra:defs.bzl", "create_all")

create_all(glob(["*.c"]))
