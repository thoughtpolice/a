// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Round-trip data through the block and frame formats.

#include <lz4.h>
#include <lz4frame.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    char src[4096];
    for (size_t i = 0; i < sizeof(src); i++) src[i] = "verilator"[i % 9];

    char block[LZ4_COMPRESSBOUND(sizeof(src))], back[sizeof(src)];
    int n = LZ4_compress_default(src, block, sizeof(src), sizeof(block));
    if (n <= 0 || n >= (int)sizeof(src)) return fprintf(stderr, "block compress: %d\n", n), 1;
    if (LZ4_decompress_safe(block, back, n, sizeof(back)) != (int)sizeof(src) || memcmp(src, back, sizeof(src)))
        return fprintf(stderr, "block round trip failed\n"), 1;

    char frame[8192];
    size_t f = LZ4F_compressFrame(frame, sizeof(frame), src, sizeof(src), NULL);
    if (LZ4F_isError(f)) return fprintf(stderr, "frame compress: %s\n", LZ4F_getErrorName(f)), 1;
    LZ4F_dctx *dctx;
    if (LZ4F_isError(LZ4F_createDecompressionContext(&dctx, LZ4F_VERSION))) return 1;
    size_t out = sizeof(back), in = f;
    size_t r = LZ4F_decompress(dctx, back, &out, frame, &in, NULL);
    LZ4F_freeDecompressionContext(dctx);
    if (r != 0 || out != sizeof(src) || memcmp(src, back, sizeof(src)))
        return fprintf(stderr, "frame round trip failed\n"), 1;
    return 0;
}
