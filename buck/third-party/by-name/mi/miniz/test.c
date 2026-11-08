// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Round-trip data through zlib-style compression and through a zip archive
// built in memory.

#include <miniz.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
    unsigned char src[4096];
    for (size_t i = 0; i < sizeof(src); i++) src[i] = (unsigned char)"deflate"[i % 7];

    mz_ulong n = mz_compressBound(sizeof(src));
    unsigned char *packed = malloc(n), back[sizeof(src)];
    if (mz_compress(packed, &n, src, sizeof(src)) != MZ_OK || n >= sizeof(src))
        return fprintf(stderr, "compress failed\n"), 1;
    mz_ulong m = sizeof(back);
    if (mz_uncompress(back, &m, packed, n) != MZ_OK || m != sizeof(src) || memcmp(src, back, m))
        return fprintf(stderr, "zlib round trip failed\n"), 1;
    free(packed);

    mz_zip_archive zip;
    memset(&zip, 0, sizeof(zip));
    void *archive;
    size_t size;
    if (!mz_zip_writer_init_heap(&zip, 0, 0) ||
        !mz_zip_writer_add_mem(&zip, "a.txt", src, sizeof(src), MZ_BEST_COMPRESSION) ||
        !mz_zip_writer_finalize_heap_archive(&zip, &archive, &size) || !mz_zip_writer_end(&zip))
        return fprintf(stderr, "zip write failed\n"), 1;

    memset(&zip, 0, sizeof(zip));
    size_t out;
    void *file;
    if (!mz_zip_reader_init_mem(&zip, archive, size, 0) ||
        !(file = mz_zip_reader_extract_file_to_heap(&zip, "a.txt", &out, 0)) ||
        out != sizeof(src) || memcmp(file, src, out))
        return fprintf(stderr, "zip read failed\n"), 1;
    mz_free(file);
    mz_zip_reader_end(&zip);
    free(archive);
    return 0;
}
