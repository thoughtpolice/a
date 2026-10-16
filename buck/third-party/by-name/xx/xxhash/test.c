// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Check each algorithm against known digests, and the streaming API against
// the one-shot functions for every way of splitting the input in two.

#include <stdio.h>
#include <string.h>
#include <xxhash.h>

static int failures = 0;

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #cond);         \
            failures++;                                                        \
        }                                                                      \
    } while (0)

static unsigned char buf[2048];

int main(void) {
    CHECK(XXH_versionNumber() == 804);

    CHECK(XXH32("", 0, 0) == 0x02cc5d05U);
    CHECK(XXH64("", 0, 0) == 0xef46db3751d8e999ULL);
    CHECK(XXH3_64bits("", 0) == 0x2d06800538d394c2ULL);
    XXH128_hash_t e = XXH3_128bits("", 0);
    CHECK(e.high64 == 0x99aa06d3014798d8ULL && e.low64 == 0x6001c324468d497fULL);

    CHECK(XXH32("abc", 3, 0) == 0x32d153ffU);
    CHECK(XXH64("abc", 3, 0) == 0x44bc2cf5ad770999ULL);
    CHECK(XXH3_64bits("abc", 3) == 0x78af5f94892f3950ULL);
    XXH128_hash_t a = XXH3_128bits("abc", 3);
    CHECK(a.high64 == 0x06b05ab6733a6185ULL && a.low64 == 0x78af5f94892f3950ULL);

    unsigned long long x = 0x9e3779b97f4a7c15ULL;
    for (size_t i = 0; i < sizeof(buf); i++) {
        x ^= x << 13, x ^= x >> 7, x ^= x << 17;
        buf[i] = (unsigned char)x;
    }

    XXH32_state_t *s32 = XXH32_createState();
    XXH64_state_t *s64 = XXH64_createState();
    XXH3_state_t *s3 = XXH3_createState();
    XXH3_state_t *s128 = XXH3_createState();
    for (size_t len = 0; len <= sizeof(buf); len += 61) {
        const XXH64_hash_t seed = len * 7919;
        const XXH32_hash_t h32 = XXH32(buf, len, (XXH32_hash_t)seed);
        const XXH64_hash_t h64 = XXH64(buf, len, seed);
        const XXH64_hash_t h3 = XXH3_64bits_withSeed(buf, len, seed);
        const XXH128_hash_t h128 = XXH3_128bits_withSeed(buf, len, seed);
        for (size_t cut = 0; cut <= len; cut += 1 + len / 16) {
            XXH32_reset(s32, (XXH32_hash_t)seed);
            XXH32_update(s32, buf, cut);
            XXH32_update(s32, buf + cut, len - cut);
            CHECK(XXH32_digest(s32) == h32);

            XXH64_reset(s64, seed);
            XXH64_update(s64, buf, cut);
            XXH64_update(s64, buf + cut, len - cut);
            CHECK(XXH64_digest(s64) == h64);

            XXH3_64bits_reset_withSeed(s3, seed);
            XXH3_64bits_update(s3, buf, cut);
            XXH3_64bits_update(s3, buf + cut, len - cut);
            CHECK(XXH3_64bits_digest(s3) == h3);

            XXH3_128bits_reset_withSeed(s128, seed);
            XXH3_128bits_update(s128, buf, cut);
            XXH3_128bits_update(s128, buf + cut, len - cut);
            CHECK(XXH128_isEqual(XXH3_128bits_digest(s128), h128));
        }
    }
    XXH32_freeState(s32);
    XXH64_freeState(s64);
    XXH3_freeState(s3);
    XXH3_freeState(s128);

    return failures != 0;
}
