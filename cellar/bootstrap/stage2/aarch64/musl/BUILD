# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "untar")
load("@cellar//bootstrap/platforms:defs.bzl", "amd64_dep")
load("@cellar//bootstrap/stage1/musl12:sources.bzl", "INTERNAL_HEADERS", "PUBLIC_HEADERS")
load(":defs.bzl", "LIBC_SOURCES")
load(":sources.bzl", "ARCH_HEADERS", "CRT_SOURCES")

OLD = "cellar//bootstrap/stage1/musl12"

amd64_dep(
    name = "archive",
    actual = OLD + ":musl.tar",
)

amd64_dep(
    name = "generated",
    actual = OLD + ":source",
)

HEADERS = [p for p in PUBLIC_HEADERS if not p.startswith("arch/x86_64/")] + ARCH_HEADERS

FILES = sorted({p: None for p in HEADERS + INTERNAL_HEADERS + LIBC_SOURCES + CRT_SOURCES + [
    "arch/aarch64/bits/alltypes.h.in",
    "arch/aarch64/bits/syscall.h.in",
    "include/alltypes.h.in",
    "tools/mkalltypes.sed",
    "COPYRIGHT",
]}.keys())

untar(
    name = "musl-1.2.5",
    files = FILES,
    input = ":archive",
    target_cpu = "arm64",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

generate(
    name = "alltypes.h",
    args = [
        "-f",
        "$(location :musl-1.2.5[tools/mkalltypes.sed])",
        "$(location :musl-1.2.5[arch/aarch64/bits/alltypes.h.in])",
        "$(location :musl-1.2.5[include/alltypes.h.in])",
    ],
    capture = True,
    target_cpu = "arm64",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

generate(
    name = "syscall.h",
    args = [
        "-n",
        "-e",
        "p;s/__NR_/SYS_/p",
        "$(location :musl-1.2.5[arch/aarch64/bits/syscall.h.in])",
    ],
    capture = True,
    target_cpu = "arm64",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

filegroup(
    name = "headers",
    srcs = {p.removeprefix("include/"): ":musl-1.2.5[" + p + "]" for p in HEADERS if p.startswith("include/")} |
           {p.removeprefix("arch/generic/"): ":musl-1.2.5[" + p + "]" for p in HEADERS if p.startswith("arch/generic/")} |
           {p.removeprefix("arch/aarch64/"): ":musl-1.2.5[" + p + "]" for p in HEADERS if p.startswith("arch/aarch64/bits/")} |
           {
               "bits/alltypes.h": ":alltypes.h",
               "bits/syscall.h": ":syscall.h",
           },
)

# Reuse the regenerated Unicode and iconv tables from the seed chain.
TABLES = [p for p in INTERNAL_HEADERS if p.startswith(("src/ctype/", "src/locale/")) and p.endswith(".h") and p.rsplit("/", 1)[1] in [
    "alpha.h",
    "punct.h",
    "nonspacing.h",
    "wide.h",
    "casemap.h",
    "big5.h",
    "codepages.h",
    "gb18030.h",
    "hkscs.h",
    "jis0208.h",
    "ksc.h",
    "legacychars.h",
    "revjis.h",
]]

filegroup(
    name = "source",
    srcs = {p: ":musl-1.2.5[" + p + "]" for p in FILES if not p.startswith("include/") and p not in TABLES and p != "src/internal/version.h"} |
           {p: ":generated[" + p + "]" for p in TABLES} |
           {
               "include": ":headers",
               "src/internal/version.h": ":generated[src/internal/version.h]",
           },
)
