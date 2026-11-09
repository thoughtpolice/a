# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":sources.bzl", "SOURCES")

GIT_COMMIT = "d38452e1ee03523a208362186fd42248ff2609f6"

shims.http_archive(
    name = "src",
    excludes = [
        "^ci/",
    ],
    sha256 = "d1abe9da2003e6cbbd7619b0ced3e52047422f4f4ac6c66a9bef5d2e99fea837",
    strip_prefix = "abseil-cpp-{}".format(GIT_COMMIT),
    sub_targets = SOURCES,
    type = "tar.gz",
    urls = [
        "https://github.com/abseil/abseil-cpp/archive/{}.tar.gz".format(GIT_COMMIT),
    ],
)

# sources.bzl is the library's sources as Abseil's CMake build lists them for
# its combined DLL. This fails when the list has moved on; to update
# sources.bzl after a version bump or a change to sources.py, run
#
#   cp $(buck2 build --show-simple-output third-party//by-name/ab/abseil-cpp:sources.bzl-new) \
#       buck/third-party/by-name/ab/abseil-cpp/sources.bzl
shims.python_binary(
    name = "sources",
    main = "sources.py",
)

shims.genrule(
    name = "sources.bzl-new",
    out = "sources.bzl",
    cmd = "$(exe :sources) $(location :src) > $OUT",
)

shims.export_file(
    name = "sources.bzl-checked-in",
    src = "sources.bzl",
)

shims.command_test(
    name = "sources-up-to-date",
    cmd = [
        "diff",
        "-u",
        "$(location :sources.bzl-checked-in)",
        "$(location :sources.bzl-new)",
    ],
)

# All of Abseil as one static library, as its CMake build makes for a DLL;
# the linker keeps only the objects a binary uses. Headers are found through
# the source tree, as `absl/...` includes expect.
#
# absl/base/options.h leaves Abseil to pick std:: types or its own by the
# language standard in use, which changes its ABI: absl::strong_ordering, for
# one, is std::strong_ordering only under C++20. Everything linking Abseil
# must therefore be compiled as the same C++ standard as Abseil, C++20 here.
shims.cxx_library(
    name = "absl",
    srcs = [":src[{}]".format(f) for f in SOURCES],
    compiler_flags = [
        "-std=c++20",
        "-Wno-deprecated-declarations",
    ],
    exported_linker_flags = shims.select({
        # absl/time reads the local time zone through CoreFoundation.
        "config//os:macos": [
            "-framework",
            "CoreFoundation",
        ],
        "DEFAULT": [],
    }),
    exported_preprocessor_flags = [
        "-isystem",
        "$(location :src)",
    ],
    preferred_linkage = "static",
    visibility = ["PUBLIC"],
)
