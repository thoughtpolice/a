/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 *
 * Write a small pax archive to standard output. Its members cover a pax
 * path longer than the ustar fields, a ustar prefix/name split, a
 * directory, an executable file and a symbolic link.
 *
 * With an argument, write one of the archives untar must handle carefully:
 *
 *   symbolic-parent  a symbolic link, then a file beneath it
 *   pax-length       a pax record too short to hold its own length
 *   gnu-header       an old GNU header with times where ustar has a prefix
 *
 * The first two begin with a "marker" file, which untar extracts before it
 * reaches the member it must reject.
 */
#include <stdio.h>
#include <string.h>

#define LONG_DIRECTORY "a-directory-name-that-is-long-enough/to-need-a-pax-path-record-because/"
#define LONG_NAME LONG_DIRECTORY "the-ustar-name-field-only-holds-one-hundred-bytes.txt"

static int gnu;

static void header(const char *name, const char *prefix, int type, unsigned mode,
                   unsigned long size, const char *link)
{
    unsigned char block[512];
    unsigned sum = 0;
    int i;
    memset(block, 0, sizeof block);
    strncpy((char *)block, name, 100);
    sprintf((char *)block + 100, "%07o", mode);
    sprintf((char *)block + 108, "%07o", 0);
    sprintf((char *)block + 116, "%07o", 0);
    sprintf((char *)block + 124, "%011lo", size);
    sprintf((char *)block + 136, "%011o", 0);
    memset(block + 148, ' ', 8);
    block[156] = type;
    if (link) strncpy((char *)block + 157, link, 100);
    if (gnu) {
        /* The old GNU format's magic and version, then its access time. */
        memcpy(block + 257, "ustar  ", 8);
        sprintf((char *)block + 345, "%011o", 01234567);
    } else {
        memcpy(block + 257, "ustar", 6);
        memcpy(block + 263, "00", 2);
        if (prefix) strncpy((char *)block + 345, prefix, 155);
    }
    for (i = 0; i < 512; i++) sum += block[i];
    sprintf((char *)block + 148, "%06o", sum);
    fwrite(block, 1, 512, stdout);
}

static void data(const char *text, size_t size)
{
    static const char zeros[512];
    fwrite(text, 1, size, stdout);
    fwrite(zeros, 1, (512 - size % 512) % 512, stdout);
}

int main(int argc, char **argv)
{
    char record[256];
    static const char zeros[1024];
    const char *contents = "long path\n";
    int length = strlen(" path=" LONG_NAME "\n");
    int digits = length + 2 < 100 ? 2 : 3;
    sprintf(record, "%d path=%s\n", length + digits, LONG_NAME);

    if (argc == 1) {
        header("top", NULL, '5', 0755, 0, NULL);
        header("PaxHeaders/long", NULL, 'x', 0644, strlen(record), NULL);
        data(record, strlen(record));
        header("truncated-ustar-name", NULL, '0', 0644, strlen(contents), NULL);
        data(contents, strlen(contents));
        header("run.sh", "top/prefix", '0', 0755, 5, NULL);
        data("exit\n", 5);
        header("top/link", NULL, '2', 0777, 0, "prefix/run.sh");
    } else if (!strcmp(argv[1], "symbolic-parent")) {
        /* A link to a directory in the archive stands in for one outside it. */
        header("marker", NULL, '0', 0644, 5, NULL);
        data("exit\n", 5);
        header("real", NULL, '5', 0755, 0, NULL);
        header("escape", NULL, '2', 0777, 0, "real");
        header("escape/redirected", NULL, '0', 0644, 5, NULL);
        data("exit\n", 5);
    } else if (!strcmp(argv[1], "pax-length")) {
        /* Leading newlines put the length field past the one-byte record. */
        static const char malformed[] = "\n\n1 path=x\n";
        header("marker", NULL, '0', 0644, 5, NULL);
        data("exit\n", 5);
        header("PaxHeaders/malformed", NULL, 'x', 0644, sizeof malformed - 1, NULL);
        data(malformed, sizeof malformed - 1);
        header("x", NULL, '0', 0644, 0, NULL);
    } else if (!strcmp(argv[1], "gnu-header")) {
        gnu = 1;
        header("gnu-file", NULL, '0', 0644, 4, NULL);
        data("gnu\n", 4);
    } else {
        return 2;
    }
    fwrite(zeros, 1, sizeof zeros, stdout);
    return fflush(stdout) || ferror(stdout);
}
