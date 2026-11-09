# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":sources.bzl", "SOURCES")

GIT_COMMIT = "74211c0dfc2777318ab53c2cd2c317a2ef9012de"

# The C runtime the C++ one validates UTF-8 with.
UTF8_RANGE_SOURCES = ["third_party/utf8_range/utf8_range.c"]

# cmake/libupb.cmake: the descriptor tables upb is bootstrapped with, checked
# in upstream for builds that cannot run protoc first.
UPB_BOOTSTRAP_SOURCES = ["upb/reflection/cmake/google/protobuf/descriptor.upb_minitable.c"]

# cmake/protoc.cmake.
PROTOC_SOURCES = ["src/google/protobuf/compiler/main.cc"]

# The .proto files cmake/install.cmake installs as include/ for `import
# "google/protobuf/..."`: wkt_protos_files and the descriptor, plugin and C++
# features protos of src/file_lists.cmake. The Java and Go features protos
# live in the excluded runtimes.
WELL_KNOWN_PROTOS = [
    "google/protobuf/any.proto",
    "google/protobuf/api.proto",
    "google/protobuf/compiler/plugin.proto",
    "google/protobuf/cpp_features.proto",
    "google/protobuf/descriptor.proto",
    "google/protobuf/duration.proto",
    "google/protobuf/empty.proto",
    "google/protobuf/field_mask.proto",
    "google/protobuf/source_context.proto",
    "google/protobuf/struct.proto",
    "google/protobuf/timestamp.proto",
    "google/protobuf/type.proto",
    "google/protobuf/wrappers.proto",
]

# The runtimes of other languages are most of the tree; nothing here builds
# them, and protoc's generators for them live under src/.
shims.http_archive(
    name = "src",
    excludes = [
        "^benchmarks/",
        "^ci/",
        "^conformance/",
        "^csharp/",
        "^docs/",
        "^examples/",
        "^hpb/",
        "^hpb_generator/",
        "^java/",
        "^lua/",
        "^objectivec/",
        "^php/",
        "^python/",
        "^ruby/",
        "^rust/",
    ],
    sha256 = "d0e3a75876a81e1536028bb9cf9181382b198da4cc6fa6aef86879ef629ac807",
    strip_prefix = "protobuf-{}".format(GIT_COMMIT),
    sub_targets = sorted(
        [f for files in SOURCES.values() for f in files] +
        UTF8_RANGE_SOURCES + UPB_BOOTSTRAP_SOURCES + PROTOC_SOURCES +
        ["src/" + f for f in WELL_KNOWN_PROTOS],
    ),
    type = "tar.gz",
    urls = [
        "https://github.com/protocolbuffers/protobuf/archive/{}.tar.gz".format(GIT_COMMIT),
    ],
)

# sources.bzl is the libraries' sources as src/file_lists.cmake lists them.
# This fails when the lists have moved on; to update sources.bzl after a
# version bump or a change to sources.py, run
#
#   cp $(buck2 build --show-simple-output third-party//by-name/pr/protobuf:sources.bzl-new) \
#       buck/third-party/by-name/pr/protobuf/sources.bzl
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

# MARK: Libraries

# Headers are found through the source tree, as the CMake build finds them:
# `google/protobuf/...` under src/, `upb/...` and `upb_generator/...` at the
# top. C++ is compiled as the standard Abseil is; see by-name/ab/abseil-cpp.
CXX_FLAGS = ["-std=c++20"]

PREPROCESSOR_FLAGS = ["-DGOOGLE_PROTOBUF_CMAKE_BUILD"]

shims.cxx_library(
    name = "utf8_range",
    srcs = [":src[{}]".format(f) for f in UTF8_RANGE_SOURCES],
    # utf8_validity.h, the C++ interface, takes absl::string_view.
    exported_deps = ["third-party//by-name/ab/abseil-cpp:absl"],
    exported_preprocessor_flags = [
        "-isystem",
        "$(location :src)/third_party/utf8_range",
    ],
    preferred_linkage = "static",
)

shims.cxx_library(
    name = "libupb",
    srcs = [":src[{}]".format(f) for f in SOURCES["libupb"] + UPB_BOOTSTRAP_SOURCES],
    exported_preprocessor_flags = [
        "-isystem",
        "$(location :src)",
        "-isystem",
        "$(location :src)/upb/reflection/cmake",
    ],
    preferred_linkage = "static",
    deps = [":utf8_range"],
)

shims.cxx_library(
    name = "libprotobuf",
    srcs = [":src[{}]".format(f) for f in SOURCES["libprotobuf"]],
    compiler_flags = CXX_FLAGS,
    exported_deps = [
        "third-party//by-name/ab/abseil-cpp:absl",
        ":utf8_range",
    ],
    exported_preprocessor_flags = [
        "-isystem",
        "$(location :src)/src",
    ],
    preferred_linkage = "static",
    preprocessor_flags = PREPROCESSOR_FLAGS,
    visibility = ["PUBLIC"],
)

shims.cxx_library(
    name = "libprotoc",
    srcs = [":src[{}]".format(f) for f in SOURCES["libprotoc"]],
    compiler_flags = CXX_FLAGS,
    exported_deps = [
        ":libprotobuf",
        ":libupb",
    ],
    preferred_linkage = "static",
    preprocessor_flags = PREPROCESSOR_FLAGS,
    visibility = ["PUBLIC"],
)

shims.cxx_binary(
    name = "protoc",
    srcs = [":src[{}]".format(f) for f in PROTOC_SOURCES],
    compiler_flags = CXX_FLAGS,
    link_style = "static",
    preprocessor_flags = PREPROCESSOR_FLAGS,
    visibility = ["PUBLIC"],
    deps = [":libprotoc"],
)

# The include directory for protoc's --proto_path (PROTOC_INCLUDE), laid out
# as an installed protoc's include/.
shims.filegroup(
    name = "well-known-protos",
    srcs = {f: ":src[src/{}]".format(f) for f in WELL_KNOWN_PROTOS},
    visibility = ["PUBLIC"],
)

# MARK: Tests

shims.command_test(
    name = "test-protoc-version",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        # Not $(...), which buck2 would read as a macro.
        "version=`\"$0\" --version` && test \"$version\" = 'libprotoc 31.1'",
        "$(exe :protoc)",
    ],
)

# Generated code for test.proto, compiled against the runtime above: the two
# have to come from the same release, which the generated header checks.
shims.genrule(
    name = "test-proto-cc",
    srcs = ["test.proto"],
    outs = {
        "test.pb.cc": ["test.pb.cc"],
        "test.pb.h": ["test.pb.h"],
    },
    cmd = "$(exe :protoc) --proto_path=$SRCDIR --cpp_out=$OUT $SRCS",
)

shims.cxx_binary(
    name = "roundtrip",
    srcs = [
        "roundtrip.cc",
        ":test-proto-cc[test.pb.cc]",
    ],
    compiler_flags = CXX_FLAGS,
    header_namespace = "",
    headers = {"test.pb.h": ":test-proto-cc[test.pb.h]"},
    deps = [":libprotobuf"],
)

shims.command_test(
    name = "test-roundtrip",
    cmd = ["$(exe :roundtrip)"],
)
