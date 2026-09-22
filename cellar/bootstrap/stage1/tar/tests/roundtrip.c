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
    put("passed", "passed\n");
    return 0;
}
