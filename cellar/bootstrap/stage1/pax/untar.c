/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 *
 * Extract a POSIX.1-2001 (pax) or ustar archive into the current directory.
 *
 *   untar -xf ARCHIVE
 *
 * Member names come from pax "path"/"linkpath" records, GNU long-name
 * members, or the ustar prefix and name fields, in that order. Other pax
 * records, such as timestamps, are ignored, and ownership is never changed.
 * Absolute names and names containing ".." are rejected, and every directory
 * a member passes through must be a directory, not a symbolic link, so no
 * member can be written outside the current directory. Regular files,
 * directories, symbolic links and hard links are supported.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define BLOCK 512

static FILE *archive;
static const char *archive_name;

static void fail(const char *message, const char *detail)
{
    fprintf(stderr, "untar: %s%s%s\n", message, detail ? ": " : "", detail ? detail : "");
    exit(1);
}

static void read_exact(void *buffer, size_t size)
{
    if (fread(buffer, 1, size, archive) != size) fail("truncated archive", archive_name);
}

static unsigned long long octal(const unsigned char *field, size_t size)
{
    unsigned long long value = 0;
    size_t i = 0;
    /* GNU base-256 encoding marks large values with the high bit. */
    if (field[0] & 0x80) {
        value = field[0] & 0x7f;
        for (i = 1; i < size; i++) value = value << 8 | field[i];
        return value;
    }
    while (i < size && (field[i] == ' ' || field[i] == 0)) i++;
    for (; i < size && field[i] >= '0' && field[i] <= '7'; i++) value = value * 8 + (field[i] - '0');
    return value;
}

static char *read_member(unsigned long long size)
{
    unsigned long long padded = (size + BLOCK - 1) / BLOCK * BLOCK;
    char *data;
    if (size > 16 * 1024 * 1024) fail("oversized metadata member", archive_name);
    data = malloc(padded + 1);
    if (!data) fail("out of memory", NULL);
    read_exact(data, padded);
    data[size] = 0;
    return data;
}

static void skip(unsigned long long size)
{
    char buffer[BLOCK];
    unsigned long long blocks = (size + BLOCK - 1) / BLOCK;
    while (blocks--) read_exact(buffer, BLOCK);
}

/* Parse "LENGTH key=value\n" records, keeping path and linkpath. LENGTH is
 * decimal digits only and covers the whole record, which must extend past
 * the space that ends it. */
static void parse_pax(char *data, unsigned long long size, char **path, char **link)
{
    char *cursor = data, *end = data + size;
    while (cursor < end) {
        char *space = cursor, *equals, *record_end;
        unsigned long long length = 0;
        while (space < end && *space >= '0' && *space <= '9') {
            length = length * 10 + (*space++ - '0');
            if (length > (unsigned long long)(end - cursor)) fail("malformed pax record", archive_name);
        }
        if (space == cursor || space == end || *space != ' ' || length < (unsigned long long)(space - cursor) + 2)
            fail("malformed pax record", archive_name);
        record_end = cursor + length;
        if (record_end[-1] != '\n') fail("malformed pax record", archive_name);
        equals = memchr(space + 1, '=', record_end - space - 1);
        if (!equals) fail("malformed pax record", archive_name);
        *equals = 0;
        record_end[-1] = 0;
        if (!strcmp(space + 1, "path")) {
            free(*path);
            *path = strdup(equals + 1);
        } else if (!strcmp(space + 1, "linkpath")) {
            free(*link);
            *link = strdup(equals + 1);
        }
        cursor = record_end;
    }
}

static void check_name(const char *name)
{
    const char *part = name;
    if (!*name || *name == '/') fail("unsafe member name", name);
    while (*part) {
        size_t length = strcspn(part, "/");
        if (length == 2 && part[0] == '.' && part[1] == '.') fail("unsafe member name", name);
        part += length;
        while (*part == '/') part++;
    }
}

static void require_directory(const char *name)
{
    struct stat info;
    if (lstat(name, &info) || !S_ISDIR(info.st_mode)) fail("not a directory", name);
}

/* Create the directories a member passes through. An existing one must be a
 * directory: an earlier symbolic link member cannot redirect this one. */
static void make_parents(char *name, int create)
{
    char *slash;
    for (slash = strchr(name, '/'); slash; slash = strchr(slash + 1, '/')) {
        *slash = 0;
        if (*name) {
            if (create && mkdir(name, 0755) && errno != EEXIST) fail("cannot create directory", name);
            require_directory(name);
        }
        *slash = '/';
    }
}

static void extract_file(const char *name, unsigned long long size, mode_t mode)
{
    char buffer[BLOCK * 64];
    unsigned long long remaining = (size + BLOCK - 1) / BLOCK * BLOCK;
    unsigned long long left = size;
    int fd;
    unlink(name);
    fd = open(name, O_WRONLY | O_CREAT | O_EXCL, mode);
    if (fd < 0) fail("cannot create file", name);
    while (remaining) {
        size_t chunk = remaining < sizeof buffer ? remaining : sizeof buffer;
        size_t keep = left < chunk ? left : chunk;
        size_t written = 0;
        read_exact(buffer, chunk);
        while (written < keep) {
            ssize_t n = write(fd, buffer + written, keep - written);
            if (n < 0) {
                if (errno == EINTR) continue;
                fail("cannot write file", name);
            }
            written += n;
        }
        remaining -= chunk;
        left -= keep;
    }
    if (fchmod(fd, mode) || close(fd)) fail("cannot finish file", name);
}

int main(int argc, char **argv)
{
    unsigned char header[BLOCK];
    char *pax_path = NULL, *pax_link = NULL, *long_name = NULL, *long_link = NULL;
    int zero_blocks = 0;
    if (argc != 3 || strcmp(argv[1], "-xf")) fail("usage: untar -xf ARCHIVE", NULL);
    archive_name = argv[2];
    archive = fopen(archive_name, "rb");
    if (!archive) fail("cannot open archive", archive_name);
    umask(0);

    for (;;) {
        unsigned long long size, sum = 0, expected;
        char field[BLOCK];
        char *name, *target;
        mode_t mode;
        int type, i;
        read_exact(header, BLOCK);
        for (i = 0; i < BLOCK && !header[i]; i++) ;
        if (i == BLOCK) {
            if (++zero_blocks == 2) break;
            continue;
        }
        zero_blocks = 0;
        for (i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? ' ' : header[i];
        expected = octal(header + 148, 8);
        if (sum != expected) fail("header checksum mismatch", archive_name);
        size = octal(header + 124, 12);
        mode = octal(header + 100, 8) & 07777;
        type = header[156];

        if (type == 'x' || type == 'g' || type == 'L' || type == 'K') {
            char *data = read_member(size);
            if (type == 'x') parse_pax(data, size, &pax_path, &pax_link);
            if (type == 'L') { free(long_name); long_name = strdup(data); }
            if (type == 'K') { free(long_link); long_link = strdup(data); }
            free(data);
            continue;
        }

        if (pax_path) {
            name = pax_path;
        } else if (long_name) {
            name = long_name;
        } else {
            size_t length = 0;
            /* Only POSIX ustar has a prefix field; old GNU headers, whose
               magic is "ustar  ", keep access and change times there. */
            if (!memcmp(header + 257, "ustar", 6) && header[345]) {
                length = strnlen((char *)header + 345, 155);
                memcpy(field, header + 345, length);
                field[length++] = '/';
            }
            memcpy(field + length, header, strnlen((char *)header, 100));
            field[length + strnlen((char *)header, 100)] = 0;
            name = strdup(field);
        }
        if (pax_link) {
            target = pax_link;
        } else if (long_link) {
            target = long_link;
        } else {
            size_t length = strnlen((char *)header + 157, 100);
            memcpy(field, header + 157, length);
            field[length] = 0;
            target = strdup(field);
        }
        if (!name || !target) fail("out of memory", NULL);
        check_name(name);
        make_parents(name, 1);

        switch (type) {
        case 0:
        case '0':
        case '7':
            extract_file(name, size, mode);
            break;
        case '5':
            while (strlen(name) > 1 && name[strlen(name) - 1] == '/') name[strlen(name) - 1] = 0;
            if (mkdir(name, 0755) && errno != EEXIST) fail("cannot create directory", name);
            require_directory(name);
            if (chmod(name, mode | 0700)) fail("cannot set directory mode", name);
            skip(size);
            break;
        case '2':
            unlink(name);
            if (symlink(target, name)) fail("cannot create symbolic link", name);
            skip(size);
            break;
        case '1':
            check_name(target);
            make_parents(target, 0);
            unlink(name);
            if (link(target, name)) fail("cannot create hard link", name);
            skip(size);
            break;
        default:
            fail("unsupported member type", name);
        }

        free(name);
        free(target);
        pax_path = pax_link = long_name = long_link = NULL;
    }
    if (fclose(archive)) fail("cannot close archive", archive_name);
    return 0;
}
