# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

shims.http_archive(
    name = "src",
    sha256 = "816c96e8e8f193b40151dad7e8ff37b1221d019dbcb9c35cd3fadbfe6477dfec",
    strip_prefix = "brotli-{}".format(VERSION),
    sub_targets = [
        "c/common/constants.c",
        "c/common/context.c",
        "c/common/dictionary.c",
        "c/common/platform.c",
        "c/common/shared_dictionary.c",
        "c/common/transform.c",
        "c/dec/bit_reader.c",
        "c/dec/decode.c",
        "c/dec/huffman.c",
        "c/dec/prefix.c",
        "c/dec/state.c",
        "c/dec/static_init.c",
        "c/enc/backward_references.c",
        "c/enc/backward_references_hq.c",
        "c/enc/bit_cost.c",
        "c/enc/block_splitter.c",
        "c/enc/brotli_bit_stream.c",
        "c/enc/cluster.c",
        "c/enc/command.c",
        "c/enc/compound_dictionary.c",
        "c/enc/compress_fragment.c",
        "c/enc/compress_fragment_two_pass.c",
        "c/enc/dictionary_hash.c",
        "c/enc/encode.c",
        "c/enc/encoder_dict.c",
        "c/enc/entropy_encode.c",
        "c/enc/fast_log.c",
        "c/enc/histogram.c",
        "c/enc/literal_cost.c",
        "c/enc/memory.c",
        "c/enc/metablock.c",
        "c/enc/static_dict.c",
        "c/enc/static_dict_lut.c",
        "c/enc/static_init.c",
        "c/enc/utf8_util.c",
        "c/include/brotli/decode.h",
        "c/include/brotli/encode.h",
        "c/include/brotli/port.h",
        "c/include/brotli/shared_dictionary.h",
        "c/include/brotli/types.h",
        "c/tools/brotli.c",
    ],
    type = "tar.gz",
    urls = [
        "https://github.com/google/brotli/archive/refs/tags/v{}.tar.gz".format(VERSION),
    ],
)

# The corpus upstream's CMake tests run against, which the source archive
# leaves out: files and their compressed forms from upstream's encoder.
shims.http_archive(
    name = "testdata",
    sha256 = "e8624d888f13067e7635353397cf42956bf4ca1382da67f9cec8d43e800deecb",
    strip_prefix = "tests/testdata",
    type = "tar.xz",
    urls = [
        "https://github.com/google/brotli/releases/download/v{}/testdata.txz".format(VERSION),
    ],
)

# The sources include each other by relative path ("../common/platform.h"),
# and the public headers as <brotli/...>; naming the tree makes it an input of
# every compile.
PREPROCESSOR_FLAGS = ["-I$(location :src)/c/include"]

# The three libraries CMake builds. Upstream's Bazel build adds -Werror, which
# would turn a newer compiler's warnings into failures here.
shims.cxx_library(
    name = "brotlicommon",
    srcs = [
        ":src[c/common/constants.c]",
        ":src[c/common/context.c]",
        ":src[c/common/dictionary.c]",
        ":src[c/common/platform.c]",
        ":src[c/common/shared_dictionary.c]",
        ":src[c/common/transform.c]",
    ],
    exported_headers = {
        "decode.h": ":src[c/include/brotli/decode.h]",
        "encode.h": ":src[c/include/brotli/encode.h]",
        "port.h": ":src[c/include/brotli/port.h]",
        "shared_dictionary.h": ":src[c/include/brotli/shared_dictionary.h]",
        "types.h": ":src[c/include/brotli/types.h]",
    },
    header_namespace = "brotli",
    preferred_linkage = "static",
    preprocessor_flags = PREPROCESSOR_FLAGS,
)

shims.cxx_library(
    name = "brotlidec",
    srcs = [
        ":src[c/dec/bit_reader.c]",
        ":src[c/dec/decode.c]",
        ":src[c/dec/huffman.c]",
        ":src[c/dec/prefix.c]",
        ":src[c/dec/state.c]",
        ":src[c/dec/static_init.c]",
    ],
    exported_deps = [":brotlicommon"],
    preferred_linkage = "static",
    preprocessor_flags = PREPROCESSOR_FLAGS,
)

shims.cxx_library(
    name = "brotlienc",
    srcs = [
        ":src[c/enc/backward_references.c]",
        ":src[c/enc/backward_references_hq.c]",
        ":src[c/enc/bit_cost.c]",
        ":src[c/enc/block_splitter.c]",
        ":src[c/enc/brotli_bit_stream.c]",
        ":src[c/enc/cluster.c]",
        ":src[c/enc/command.c]",
        ":src[c/enc/compound_dictionary.c]",
        ":src[c/enc/compress_fragment.c]",
        ":src[c/enc/compress_fragment_two_pass.c]",
        ":src[c/enc/dictionary_hash.c]",
        ":src[c/enc/encode.c]",
        ":src[c/enc/encoder_dict.c]",
        ":src[c/enc/entropy_encode.c]",
        ":src[c/enc/fast_log.c]",
        ":src[c/enc/histogram.c]",
        ":src[c/enc/literal_cost.c]",
        ":src[c/enc/memory.c]",
        ":src[c/enc/metablock.c]",
        ":src[c/enc/static_dict.c]",
        ":src[c/enc/static_dict_lut.c]",
        ":src[c/enc/static_init.c]",
        ":src[c/enc/utf8_util.c]",
    ],
    exported_deps = [":brotlicommon"],
    exported_linker_flags = shims.select({
        "config//os:windows": [],
        "DEFAULT": ["-lm"],
    }),
    preferred_linkage = "static",
    preprocessor_flags = PREPROCESSOR_FLAGS,
)

shims.cxx_binary(
    name = "brotli",
    srcs = [":src[c/tools/brotli.c]"],
    preprocessor_flags = PREPROCESSOR_FLAGS,
    visibility = ["PUBLIC"],
    deps = [
        ":brotlidec",
        ":brotlienc",
    ],
)

shims.cxx_binary(
    name = "test-roundtrip-bin",
    srcs = ["test.c"],
    deps = [
        ":brotlidec",
        ":brotlienc",
    ],
)

shims.command_test(
    name = "test-roundtrip",
    cmd = ["$(exe :test-roundtrip-bin)"],
)

# What upstream's CMake tests do with the CLI: decompress every file of the
# corpus that upstream's encoder compressed and compare it with the original,
# then round-trip the larger texts and some of brotli's own sources at the
# qualities CMake picks.
shims.command_test(
    name = "test-corpus",
    # Backquotes, not $(...), which Buck would read as a macro. Pipes, not
    # files: a sandboxed test has nowhere to write them.
    script = """
        brotli=$(exe :brotli)
        testdata=$(location :testdata)
        src=$(location :src)

        test "`$brotli --version`" = "brotli {version}"

        n=0
        for f in "$testdata"/*.compressed*; do
            name=`basename "$f"`
            $brotli --decompress --stdout "$f" | cmp "$testdata/${{name%%.compressed*}}" -
            n=`expr $n + 1`
        done
        test $n -eq 45

        for f in "$testdata/alice29.txt" "$testdata/asyoulik.txt" "$testdata/lcet10.txt" "$testdata/plrabn12.txt" "$src/c/enc/encode.c" "$src/c/common/dictionary.h" "$src/c/dec/decode.c"; do
            for quality in 1 6 9 11; do
                $brotli --quality=$quality --stdout "$f" | $brotli --decompress --stdout | cmp "$f" -
            done
        done
    """.format(version = VERSION),
)
