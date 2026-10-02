# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap/stage1/musl12:sources.bzl", "BASE_C_SOURCES")
load(":sources.bzl", "ARCH_SOURCES")

_REPLACED = [path.replace("/aarch64/", "/").rsplit(".", 1)[0] + ".c" for path in ARCH_SOURCES]
LIBC_SOURCES = sorted([path for path in BASE_C_SOURCES if path not in _REPLACED] + ARCH_SOURCES)
INCLUDE_DIRECTORIES = ["arch/aarch64", "arch/generic", "src/include", "src/internal", "include"]
