// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Round-trip data through the one-shot and streaming APIs at several
// qualities and window sizes.

#include <brotli/decode.h>
#include <brotli/encode.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #cond);         \
            failures++;                                                        \
        }                                                                      \
    } while (0)

enum { N = 1 << 18 };

static uint8_t src[N], back[N];

// Compress `n` bytes of `in` a few bytes at a time, as a caller feeding a
// stream would, and return the compressed size.
static size_t compress_stream(const uint8_t *in, size_t n, uint8_t *out, size_t cap, int quality) {
    BrotliEncoderState *s = BrotliEncoderCreateInstance(NULL, NULL, NULL);
    BrotliEncoderSetParameter(s, BROTLI_PARAM_QUALITY, (uint32_t)quality);
    size_t avail_in = 0, avail_out = cap;
    const uint8_t *next_in = in;
    uint8_t *next_out = out;
    size_t fed = 0;
    for (;;) {
        if (avail_in == 0 && fed < n) {
            size_t chunk = n - fed < 4093 ? n - fed : 4093;
            next_in = in + fed, avail_in = chunk, fed += chunk;
        }
        BrotliEncoderOperation op = fed == n ? BROTLI_OPERATION_FINISH : BROTLI_OPERATION_PROCESS;
        if (!BrotliEncoderCompressStream(s, op, &avail_in, &next_in, &avail_out, &next_out, NULL)) break;
        if (BrotliEncoderIsFinished(s)) break;
    }
    int ok = BrotliEncoderIsFinished(s);
    BrotliEncoderDestroyInstance(s);
    return ok ? cap - avail_out : 0;
}

int main(void) {
    CHECK(BrotliEncoderVersion() == 0x1002000);
    CHECK(BrotliDecoderVersion() == 0x1002000);

    // Text-like data: words from a small vocabulary, chosen pseudorandomly.
    static const char *words[] = {"brotli", "buck", "compress", "the", "a", "window", "quality", "\n"};
    uint32_t x = 2463534242u;
    for (size_t i = 0; i < N;) {
        x ^= x << 13, x ^= x >> 17, x ^= x << 5;
        const char *w = words[x % 8];
        for (size_t j = 0; w[j] && i < N; j++) src[i++] = (uint8_t)w[j];
        if (i < N) src[i++] = ' ';
    }

    size_t cap = BrotliEncoderMaxCompressedSize(N);
    uint8_t *buf = malloc(cap);
    const int qualities[] = {0, 1, 5, 9, 11};
    const int lgwins[] = {BROTLI_MIN_WINDOW_BITS, 16, BROTLI_DEFAULT_WINDOW, BROTLI_MAX_WINDOW_BITS};
    for (size_t q = 0; q < sizeof(qualities) / sizeof(*qualities); q++) {
        for (size_t w = 0; w < sizeof(lgwins) / sizeof(*lgwins); w++) {
            size_t n = cap;
            CHECK(BrotliEncoderCompress(qualities[q], lgwins[w], BROTLI_MODE_TEXT, N, src, &n, buf));
            CHECK(n < N / 2);
            size_t m = N;
            CHECK(BrotliDecoderDecompress(n, buf, &m, back) == BROTLI_DECODER_RESULT_SUCCESS);
            CHECK(m == N && memcmp(src, back, N) == 0);
        }

        size_t n = compress_stream(src, N, buf, cap, qualities[q]);
        CHECK(n > 0);

        // Decompress a byte at a time, so every state boundary is crossed.
        BrotliDecoderState *d = BrotliDecoderCreateInstance(NULL, NULL, NULL);
        const uint8_t *next_in = buf;
        uint8_t *next_out = back;
        size_t avail_out = N, total = 0;
        BrotliDecoderResult r = BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT;
        for (size_t i = 0; i < n && r != BROTLI_DECODER_RESULT_SUCCESS; i++) {
            size_t avail_in = 1;
            r = BrotliDecoderDecompressStream(d, &avail_in, &next_in, &avail_out, &next_out, &total);
            CHECK(r != BROTLI_DECODER_RESULT_ERROR);
        }
        CHECK(r == BROTLI_DECODER_RESULT_SUCCESS);
        CHECK(total == N && memcmp(src, back, N) == 0);
        BrotliDecoderDestroyInstance(d);
    }

    // Corrupt input must be rejected, not decoded into something.
    size_t n = cap;
    CHECK(BrotliEncoderCompress(5, BROTLI_DEFAULT_WINDOW, BROTLI_MODE_GENERIC, N, src, &n, buf));
    buf[n / 2] ^= 0x55;
    size_t m = N;
    BrotliDecoderResult r = BrotliDecoderDecompress(n, buf, &m, back);
    CHECK(r != BROTLI_DECODER_RESULT_SUCCESS || m != N || memcmp(src, back, N) != 0);

    free(buf);
    return failures != 0;
}
