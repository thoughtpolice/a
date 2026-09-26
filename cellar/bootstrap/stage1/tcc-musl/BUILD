# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load(":defs.bzl", "musl_tcc")

BOOT = "cellar//bootstrap/stage1/tcc"

MUSL = "cellar//bootstrap/stage1/musl"

# The TCC 0.9.26 fixed point compiles the release against the initial musl.
musl_tcc(
    name = "musl0",
    libc = "initial",
    link_runtime = MUSL + ":initial-link-runtime",
    predecessor = BOOT + ":tcc-boot2",
    predecessor_runtime = BOOT + ":runtime-boot1",
    sysroot = MUSL + ":runtime-initial",
)

# The musl-linked release compiles itself.
musl_tcc(
    name = "musl1",
    libc = "initial",
    link_runtime = ":musl0-link-runtime",
    predecessor = ":tcc-musl0",
    predecessor_runtime = MUSL + ":runtime-initial",
    sysroot = ":runtime-musl0",
)

# The self-built compiler compiles itself again against the rebuilt musl.
musl_tcc(
    name = "musl2",
    libc = "rebuilt",
    link_runtime = MUSL + ":rebuilt-link-runtime",
    predecessor = ":tcc-musl1",
    predecessor_runtime = MUSL + ":runtime-initial",
    sysroot = MUSL + ":runtime-rebuilt",
)
