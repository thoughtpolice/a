# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# musl's source selection for x86_64 and its installed layout, shared by
# every compiler that builds musl and every installation that holds it.

load(":sources.bzl", "ARCH_SOURCES", "BASE_C_SOURCES", "PUBLIC_HEADERS")

# An architecture's file replaces the generic C file of the same name.
_REPLACED = [path.replace("/x86_64/", "/").rsplit(".", 1)[0] + ".c" for path in ARCH_SOURCES]

LIBC_SOURCES = sorted([path for path in BASE_C_SOURCES if path not in _REPLACED] + ARCH_SOURCES)

# The source tree's include path, in the order musl's Makefile gives it.
INCLUDE_DIRECTORIES = [
    "arch/x86_64",
    "arch/generic",
    "src/include",
    "src/internal",
    "include",
]

# musl installs these empty, for programs that name them.
COMPAT_LIBRARIES = [
    "m",
    "rt",
    "pthread",
    "crypt",
    "util",
    "xnet",
    "resolv",
    "dl",
]

# The installed headers: the include directory with the x86_64 and generic
# architecture headers merged in, and the two headers musl generates.
INSTALLED_HEADERS = sorted({
    path.removeprefix(prefix): None
    for prefix in [
        "include/",
        "arch/generic/",
        "arch/x86_64/",
    ]
    for path in PUBLIC_HEADERS
    if path.startswith(prefix)
}.keys() + [
    "bits/alltypes.h",
    "bits/syscall.h",
])
