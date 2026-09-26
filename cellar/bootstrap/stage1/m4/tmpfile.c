/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#define _GNU_SOURCE 1
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Diversions spill into the caller's declared writable directory. */
FILE *m4_tmpfile(void)
{
    const char *directory = getenv("TMPDIR");
    char *path;
    size_t length;
    int fd, saved;
    FILE *stream;
    if (!directory || !*directory) { errno = ENOENT; return NULL; }
    length = strlen(directory);
    if (length > SIZE_MAX - sizeof("/m4-XXXXXX")) {
        errno = ENAMETOOLONG;
        return NULL;
    }
    path = malloc(length + sizeof("/m4-XXXXXX"));
    if (!path) return NULL;
    memcpy(path, directory, length);
    memcpy(path + length, "/m4-XXXXXX", sizeof("/m4-XXXXXX"));
    fd = mkstemp(path);
    if (fd < 0) { saved = errno; free(path); errno = saved; return NULL; }
    if (unlink(path) < 0) {
        saved = errno; close(fd); free(path); errno = saved; return NULL;
    }
    free(path);
    stream = fdopen(fd, "w+");
    if (!stream) { saved = errno; close(fd); errno = saved; }
    return stream;
}
