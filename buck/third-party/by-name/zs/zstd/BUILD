# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

shims.http_archive(
    name = "src",
    sha256 = "37d7284556b20954e56e1ca85b80226768902e2edabd3b649e9e72c0c9012ee3",
    strip_prefix = "zstd-{VERSION}".format(VERSION = VERSION),
    sub_targets = [
        # public headers
        "lib/zstd.h",
        "lib/zstd_errors.h",
        "lib/zdict.h",

        # common/
        "lib/common/allocations.h",
        "lib/common/bits.h",
        "lib/common/bitstream.h",
        "lib/common/compiler.h",
        "lib/common/cpu.h",
        "lib/common/debug.c",
        "lib/common/debug.h",
        "lib/common/entropy_common.c",
        "lib/common/error_private.c",
        "lib/common/error_private.h",
        "lib/common/fse.h",
        "lib/common/fse_decompress.c",
        "lib/common/huf.h",
        "lib/common/mem.h",
        "lib/common/pool.c",
        "lib/common/pool.h",
        "lib/common/portability_macros.h",
        "lib/common/threading.c",
        "lib/common/threading.h",
        "lib/common/xxhash.c",
        "lib/common/xxhash.h",
        "lib/common/zstd_common.c",
        "lib/common/zstd_deps.h",
        "lib/common/zstd_internal.h",
        "lib/common/zstd_trace.h",

        # compress/
        "lib/compress/clevels.h",
        "lib/compress/fse_compress.c",
        "lib/compress/hist.c",
        "lib/compress/hist.h",
        "lib/compress/huf_compress.c",
        "lib/compress/zstd_compress.c",
        "lib/compress/zstd_compress_internal.h",
        "lib/compress/zstd_compress_literals.c",
        "lib/compress/zstd_compress_literals.h",
        "lib/compress/zstd_compress_sequences.c",
        "lib/compress/zstd_compress_sequences.h",
        "lib/compress/zstd_compress_superblock.c",
        "lib/compress/zstd_compress_superblock.h",
        "lib/compress/zstd_cwksp.h",
        "lib/compress/zstd_double_fast.c",
        "lib/compress/zstd_double_fast.h",
        "lib/compress/zstd_fast.c",
        "lib/compress/zstd_fast.h",
        "lib/compress/zstd_lazy.c",
        "lib/compress/zstd_lazy.h",
        "lib/compress/zstd_ldm.c",
        "lib/compress/zstd_ldm.h",
        "lib/compress/zstd_ldm_geartab.h",
        "lib/compress/zstd_opt.c",
        "lib/compress/zstd_opt.h",
        "lib/compress/zstd_preSplit.c",
        "lib/compress/zstd_preSplit.h",
        "lib/compress/zstdmt_compress.c",
        "lib/compress/zstdmt_compress.h",

        # decompress/
        "lib/decompress/huf_decompress.c",
        "lib/decompress/huf_decompress_amd64.S",
        "lib/decompress/zstd_ddict.c",
        "lib/decompress/zstd_ddict.h",
        "lib/decompress/zstd_decompress.c",
        "lib/decompress/zstd_decompress_block.c",
        "lib/decompress/zstd_decompress_block.h",
        "lib/decompress/zstd_decompress_internal.h",

        # dictBuilder/
        "lib/dictBuilder/cover.c",
        "lib/dictBuilder/cover.h",
        "lib/dictBuilder/divsufsort.c",
        "lib/dictBuilder/divsufsort.h",
        "lib/dictBuilder/fastcover.c",
        "lib/dictBuilder/zdict.c",

        # deprecated/
        "lib/deprecated/zbuff.h",
        "lib/deprecated/zbuff_common.c",
        "lib/deprecated/zbuff_compress.c",
        "lib/deprecated/zbuff_decompress.c",

        # legacy/
        "lib/legacy/zstd_legacy.h",
        "lib/legacy/zstd_v01.c",
        "lib/legacy/zstd_v01.h",
        "lib/legacy/zstd_v02.c",
        "lib/legacy/zstd_v02.h",
        "lib/legacy/zstd_v03.c",
        "lib/legacy/zstd_v03.h",
        "lib/legacy/zstd_v04.c",
        "lib/legacy/zstd_v04.h",
        "lib/legacy/zstd_v05.c",
        "lib/legacy/zstd_v05.h",
        "lib/legacy/zstd_v06.c",
        "lib/legacy/zstd_v06.h",
        "lib/legacy/zstd_v07.c",
        "lib/legacy/zstd_v07.h",
    ],
    type = "tar.gz",
    urls = [
        "https://github.com/facebook/zstd/archive/refs/tags/v{VERSION}.tar.gz".format(VERSION = VERSION),
    ],
)

# Reconstruct the lib/ directory tree so that relative includes like
# #include "../common/mem.h" resolve correctly in sandboxed builds.
shims.copy_files(
    name = "lib",
    srcs = {
        # public headers
        "zstd.h": ":src[lib/zstd.h]",
        "zstd_errors.h": ":src[lib/zstd_errors.h]",
        "zdict.h": ":src[lib/zdict.h]",

        # common/
        "common/allocations.h": ":src[lib/common/allocations.h]",
        "common/bits.h": ":src[lib/common/bits.h]",
        "common/bitstream.h": ":src[lib/common/bitstream.h]",
        "common/compiler.h": ":src[lib/common/compiler.h]",
        "common/cpu.h": ":src[lib/common/cpu.h]",
        "common/debug.c": ":src[lib/common/debug.c]",
        "common/debug.h": ":src[lib/common/debug.h]",
        "common/entropy_common.c": ":src[lib/common/entropy_common.c]",
        "common/error_private.c": ":src[lib/common/error_private.c]",
        "common/error_private.h": ":src[lib/common/error_private.h]",
        "common/fse.h": ":src[lib/common/fse.h]",
        "common/fse_decompress.c": ":src[lib/common/fse_decompress.c]",
        "common/huf.h": ":src[lib/common/huf.h]",
        "common/mem.h": ":src[lib/common/mem.h]",
        "common/pool.c": ":src[lib/common/pool.c]",
        "common/pool.h": ":src[lib/common/pool.h]",
        "common/portability_macros.h": ":src[lib/common/portability_macros.h]",
        "common/threading.c": ":src[lib/common/threading.c]",
        "common/threading.h": ":src[lib/common/threading.h]",
        "common/xxhash.c": ":src[lib/common/xxhash.c]",
        "common/xxhash.h": ":src[lib/common/xxhash.h]",
        "common/zstd_common.c": ":src[lib/common/zstd_common.c]",
        "common/zstd_deps.h": ":src[lib/common/zstd_deps.h]",
        "common/zstd_internal.h": ":src[lib/common/zstd_internal.h]",
        "common/zstd_trace.h": ":src[lib/common/zstd_trace.h]",

        # compress/
        "compress/clevels.h": ":src[lib/compress/clevels.h]",
        "compress/fse_compress.c": ":src[lib/compress/fse_compress.c]",
        "compress/hist.c": ":src[lib/compress/hist.c]",
        "compress/hist.h": ":src[lib/compress/hist.h]",
        "compress/huf_compress.c": ":src[lib/compress/huf_compress.c]",
        "compress/zstd_compress.c": ":src[lib/compress/zstd_compress.c]",
        "compress/zstd_compress_internal.h": ":src[lib/compress/zstd_compress_internal.h]",
        "compress/zstd_compress_literals.c": ":src[lib/compress/zstd_compress_literals.c]",
        "compress/zstd_compress_literals.h": ":src[lib/compress/zstd_compress_literals.h]",
        "compress/zstd_compress_sequences.c": ":src[lib/compress/zstd_compress_sequences.c]",
        "compress/zstd_compress_sequences.h": ":src[lib/compress/zstd_compress_sequences.h]",
        "compress/zstd_compress_superblock.c": ":src[lib/compress/zstd_compress_superblock.c]",
        "compress/zstd_compress_superblock.h": ":src[lib/compress/zstd_compress_superblock.h]",
        "compress/zstd_cwksp.h": ":src[lib/compress/zstd_cwksp.h]",
        "compress/zstd_double_fast.c": ":src[lib/compress/zstd_double_fast.c]",
        "compress/zstd_double_fast.h": ":src[lib/compress/zstd_double_fast.h]",
        "compress/zstd_fast.c": ":src[lib/compress/zstd_fast.c]",
        "compress/zstd_fast.h": ":src[lib/compress/zstd_fast.h]",
        "compress/zstd_lazy.c": ":src[lib/compress/zstd_lazy.c]",
        "compress/zstd_lazy.h": ":src[lib/compress/zstd_lazy.h]",
        "compress/zstd_ldm.c": ":src[lib/compress/zstd_ldm.c]",
        "compress/zstd_ldm.h": ":src[lib/compress/zstd_ldm.h]",
        "compress/zstd_ldm_geartab.h": ":src[lib/compress/zstd_ldm_geartab.h]",
        "compress/zstd_opt.c": ":src[lib/compress/zstd_opt.c]",
        "compress/zstd_opt.h": ":src[lib/compress/zstd_opt.h]",
        "compress/zstd_preSplit.c": ":src[lib/compress/zstd_preSplit.c]",
        "compress/zstd_preSplit.h": ":src[lib/compress/zstd_preSplit.h]",
        "compress/zstdmt_compress.c": ":src[lib/compress/zstdmt_compress.c]",
        "compress/zstdmt_compress.h": ":src[lib/compress/zstdmt_compress.h]",

        # decompress/
        "decompress/huf_decompress.c": ":src[lib/decompress/huf_decompress.c]",
        "decompress/huf_decompress_amd64.S": ":src[lib/decompress/huf_decompress_amd64.S]",
        "decompress/zstd_ddict.c": ":src[lib/decompress/zstd_ddict.c]",
        "decompress/zstd_ddict.h": ":src[lib/decompress/zstd_ddict.h]",
        "decompress/zstd_decompress.c": ":src[lib/decompress/zstd_decompress.c]",
        "decompress/zstd_decompress_block.c": ":src[lib/decompress/zstd_decompress_block.c]",
        "decompress/zstd_decompress_block.h": ":src[lib/decompress/zstd_decompress_block.h]",
        "decompress/zstd_decompress_internal.h": ":src[lib/decompress/zstd_decompress_internal.h]",

        # dictBuilder/
        "dictBuilder/cover.c": ":src[lib/dictBuilder/cover.c]",
        "dictBuilder/cover.h": ":src[lib/dictBuilder/cover.h]",
        "dictBuilder/divsufsort.c": ":src[lib/dictBuilder/divsufsort.c]",
        "dictBuilder/divsufsort.h": ":src[lib/dictBuilder/divsufsort.h]",
        "dictBuilder/fastcover.c": ":src[lib/dictBuilder/fastcover.c]",
        "dictBuilder/zdict.c": ":src[lib/dictBuilder/zdict.c]",

        # deprecated/
        "deprecated/zbuff.h": ":src[lib/deprecated/zbuff.h]",
        "deprecated/zbuff_common.c": ":src[lib/deprecated/zbuff_common.c]",
        "deprecated/zbuff_compress.c": ":src[lib/deprecated/zbuff_compress.c]",
        "deprecated/zbuff_decompress.c": ":src[lib/deprecated/zbuff_decompress.c]",

        # legacy/
        "legacy/zstd_legacy.h": ":src[lib/legacy/zstd_legacy.h]",
        "legacy/zstd_v01.c": ":src[lib/legacy/zstd_v01.c]",
        "legacy/zstd_v01.h": ":src[lib/legacy/zstd_v01.h]",
        "legacy/zstd_v02.c": ":src[lib/legacy/zstd_v02.c]",
        "legacy/zstd_v02.h": ":src[lib/legacy/zstd_v02.h]",
        "legacy/zstd_v03.c": ":src[lib/legacy/zstd_v03.c]",
        "legacy/zstd_v03.h": ":src[lib/legacy/zstd_v03.h]",
        "legacy/zstd_v04.c": ":src[lib/legacy/zstd_v04.c]",
        "legacy/zstd_v04.h": ":src[lib/legacy/zstd_v04.h]",
        "legacy/zstd_v05.c": ":src[lib/legacy/zstd_v05.c]",
        "legacy/zstd_v05.h": ":src[lib/legacy/zstd_v05.h]",
        "legacy/zstd_v06.c": ":src[lib/legacy/zstd_v06.c]",
        "legacy/zstd_v06.h": ":src[lib/legacy/zstd_v06.h]",
        "legacy/zstd_v07.c": ":src[lib/legacy/zstd_v07.c]",
        "legacy/zstd_v07.h": ":src[lib/legacy/zstd_v07.h]",
    },
)

shims.cxx_library(
    name = "zstd",
    srcs = [
        # common/
        ":lib[common/debug.c]",
        ":lib[common/entropy_common.c]",
        ":lib[common/error_private.c]",
        ":lib[common/fse_decompress.c]",
        ":lib[common/pool.c]",
        ":lib[common/threading.c]",
        ":lib[common/xxhash.c]",
        ":lib[common/zstd_common.c]",

        # compress/
        ":lib[compress/fse_compress.c]",
        ":lib[compress/hist.c]",
        ":lib[compress/huf_compress.c]",
        ":lib[compress/zstd_compress.c]",
        ":lib[compress/zstd_compress_literals.c]",
        ":lib[compress/zstd_compress_sequences.c]",
        ":lib[compress/zstd_compress_superblock.c]",
        ":lib[compress/zstd_double_fast.c]",
        ":lib[compress/zstd_fast.c]",
        ":lib[compress/zstd_lazy.c]",
        ":lib[compress/zstd_ldm.c]",
        ":lib[compress/zstd_opt.c]",
        ":lib[compress/zstd_preSplit.c]",
        ":lib[compress/zstdmt_compress.c]",

        # decompress/ (includes x86_64 ASM; self-gates via preprocessor)
        ":lib[decompress/huf_decompress.c]",
        ":lib[decompress/huf_decompress_amd64.S]",
        ":lib[decompress/zstd_ddict.c]",
        ":lib[decompress/zstd_decompress.c]",
        ":lib[decompress/zstd_decompress_block.c]",

        # dictBuilder/
        ":lib[dictBuilder/cover.c]",
        ":lib[dictBuilder/divsufsort.c]",
        ":lib[dictBuilder/fastcover.c]",
        ":lib[dictBuilder/zdict.c]",

        # deprecated/
        ":lib[deprecated/zbuff_common.c]",
        ":lib[deprecated/zbuff_compress.c]",
        ":lib[deprecated/zbuff_decompress.c]",

        # legacy/
        ":lib[legacy/zstd_v01.c]",
        ":lib[legacy/zstd_v02.c]",
        ":lib[legacy/zstd_v03.c]",
        ":lib[legacy/zstd_v04.c]",
        ":lib[legacy/zstd_v05.c]",
        ":lib[legacy/zstd_v06.c]",
        ":lib[legacy/zstd_v07.c]",
    ],
    exported_headers = {
        "zstd.h": ":src[lib/zstd.h]",
        "zstd_errors.h": ":src[lib/zstd_errors.h]",
        "zdict.h": ":src[lib/zdict.h]",
    },
    header_namespace = "",
    linker_flags = [
        "-pthread",
    ],
    preferred_linkage = "static",
    preprocessor_flags = [
        "-I$(location :lib)",
        "-DXXH_NAMESPACE=ZSTD_",
        "-DZSTD_MULTITHREAD",
        "-DZSTD_LEGACY_SUPPORT=4",
    ],
)
