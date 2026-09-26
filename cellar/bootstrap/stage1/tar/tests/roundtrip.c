/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#define _GNU_SOURCE 1
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <utime.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void check(int ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "%s: %s\n", what, strerror(errno));
        exit(1);
    }
}

static void put(const char *path, const char *data)
{
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0640);
    size_t n = strlen(data);
    check(fd >= 0, path);
    check(write(fd, data, n) == n, "write");
    check(close(fd) == 0, "close");
}

static void equal(const char *path, const char *expected)
{
    char buf[1024];
    int fd = open(path, O_RDONLY);
    ssize_t n;
    check(fd >= 0, path);
    n = read(fd, buf, sizeof(buf));
    check(n == strlen(expected) && memcmp(buf, expected, n) == 0, path);
    check(close(fd) == 0, "close");
}

static int run(char **args)
{
    int status;
    pid_t child = fork();
    check(child >= 0, "fork");
    if (!child) {
        execv(args[0], args);
        perror("execv");
        _exit(127);
    }
    check(waitpid(child, &status, 0) == child, "waitpid");
    check(WIFEXITED(status), "tar exited normally");
    return WEXITSTATUS(status);
}

/* Construct full-width POSIX name fields independently of tar's writer:
   old GNU tar emits a long-name extension at this boundary. */
static void entry(FILE *f, const char *name, const char *link)
{
    unsigned char h[512] = {0}, data[512] = {0};
    unsigned sum = 0;
    int i;
    memcpy(h, name, strlen(name));
    memcpy(h + 100, "0000640", 7);
    memcpy(h + 108, "0000000", 7);
    memcpy(h + 116, "0000000", 7);
    memcpy(h + 124, link ? "00000000000" : "00000000004", 11);
    memcpy(h + 136, "00000000000", 11);
    memset(h + 148, ' ', 8);
    h[156] = link ? '2' : '0';
    if (link) memcpy(h + 157, link, strlen(link));
    memcpy(h + 257, "ustar  ", 7);
    for (i = 0; i < 512; ++i) sum += h[i];
    sprintf((char *)h + 148, "%06o", sum);
    h[155] = ' ';
    check(fwrite(h, 1, 512, f) == 512, "header write");
    if (!link) {
        memcpy(data, "full", 4);
        check(fwrite(data, 1, 512, f) == 512, "data write");
    }
}

static void full_names(const char *tar)
{
    char a[100], b[101], path[120], target[101];
    char zeros[1024] = {0};
    FILE *f = fopen("full.tar", "wb");
    char *extract[] = { (char *)tar, "--numeric-owner", "-xf", "full.tar", "-C", "output", NULL };
    check(f != NULL, "open boundary archive");
    memset(a, 'a', 99); a[99] = 0;
    memset(b, 'b', 100); b[100] = 0;
    entry(f, a, NULL);
    entry(f, b, NULL);
    entry(f, "full-link", b);
    check(fwrite(zeros, 1, sizeof(zeros), f) == sizeof(zeros), "archive terminator");
    check(fclose(f) == 0, "close boundary archive");
    check(run(extract) == 0, "extract full-width names");
    sprintf(path, "output/%s", a); equal(path, "full");
    sprintf(path, "output/%s", b); equal(path, "full");
    check(readlink("output/full-link", target, sizeof(target)) == 100, "full link length");
    check(memcmp(target, b, 100) == 0, "full link target");
}

int main(int argc, char **argv)
{
    char name[221], path[256], target[256];
    struct stat a, b;
    struct utimbuf times;
    char *create[] = { argv[1], "--numeric-owner", "-cf", "archive.tar", "-C", "input", ".", NULL };
    char *extract[] = { argv[1], "--numeric-owner", "-xpf", "archive.tar", "-C", "output", NULL };
    char *compare[] = { argv[1], "--numeric-owner", "-df", "archive.tar", "-C", "output", NULL };
    char *select[] = { argv[1], "--numeric-owner", "-cf", "recent.tar", "--newer-mtime=2000-01-02 00:00:00 UTC", "-C", "input", "old", "new", NULL };
    char *recent[] = { argv[1], "--numeric-owner", "-xf", "recent.tar", "-C", "recent", NULL };
    char *invalid[] = { argv[1], "--numeric-owner", "-tf", "invalid.tar", NULL };
    check(argc == 2, "tar argument");
    umask(0);
    check(mkdir("input", 0750) == 0, "mkdir input");
    check(mkdir("output", 0750) == 0, "mkdir output");
    check(mkdir("recent", 0750) == 0, "mkdir recent");
    memset(name, 'n', 220);
    name[220] = 0;
    sprintf(path, "input/%s", name);
    put(path, "long filename contents\n");
    check(link(path, "input/hard") == 0, "hardlink");
    check(symlink(name, "input/symbolic") == 0, "long symlink target");
    put("input/old", "old\n");
    put("input/new", "new\n");
    times.actime = times.modtime = 946684800;
    check(utime("input/old", &times) == 0, "old timestamp");
    times.actime = times.modtime = 946857600;
    check(utime("input/new", &times) == 0, "new timestamp");
    check(run(create) == 0, "create archive");
    check(run(extract) == 0, "extract archive");
    sprintf(path, "output/%s", name);
    equal(path, "long filename contents\n");
    check(stat(path, &a) == 0 && stat("output/hard", &b) == 0, "stat hardlinks");
    check(a.st_ino == b.st_ino && a.st_nlink == 2, "hardlinks preserved");
    check((a.st_mode & 0777) == 0640, "file mode preserved");
    check(readlink("output/symbolic", target, sizeof(target)) == 220, "symlink size");
    check(memcmp(target, name, 220) == 0, "symlink target");
    check(run(compare) == 0, "compare archive");
    check(run(select) == 0 && run(recent) == 0, "date-selected archive");
    equal("recent/new", "new\n");
    errno = 0;
    check(stat("recent/old", &a) == -1 && errno == ENOENT, "old file excluded");
    put("invalid.tar", "invalid archive\n");
    check(run(invalid) != 0, "malformed archive rejected");
    full_names(argv[1]);
    put("passed", "passed\n");
    return 0;
}
