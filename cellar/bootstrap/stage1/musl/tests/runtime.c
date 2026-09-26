/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    char buffer[80], *allocation;
    int fds[2], status;
    pid_t child;
    jmp_buf jump;
    volatile int seen = 0;
    if (argc != 3 || strcmp(argv[1], "startup") || strcmp(argv[2], "ok")) return 1;
    if (!getenv("BOOTSTRAP_TEST") || strcmp(getenv("BOOTSTRAP_TEST"), "present")) return 2;
    errno = 0;
    if (open("/bootstrap-file-that-does-not-exist", O_RDONLY) != -1 || errno != ENOENT) return 3;
    if (snprintf(buffer, sizeof buffer, "%s %d %.2f %lld", "musl", 42, 1.25, 1234567890123LL) != 26) return 4;
    if (strcmp(buffer, "musl 42 1.25 1234567890123")) return 5;
    allocation = malloc(100000);
    if (!allocation) return 6;
    memset(allocation, 0x5a, 100000);
    if (allocation[99999] != 0x5a) return 16;
    allocation = realloc(allocation, 200000);
    if (!allocation) return 17;
    if (allocation[99999] != 0x5a) return 7;
    free(allocation);
    allocation = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (allocation == MAP_FAILED) return 8;
    allocation[4095] = 37;
    if (munmap(allocation, 4096)) return 9;
    if (!setjmp(jump)) { seen = 1; longjmp(jump, 0); }
    if (!seen) return 10;
    if (strtod("1.25e2", 0) != 125.0 || sqrt(81.0) != 9.0) return 11;
    if (pipe(fds)) return 12;
    child = fork();
    if (child < 0) return 13;
    if (!child) {
        close(fds[0]);
        if (write(fds[1], "child", 5) != 5) _exit(21);
        _exit(23);
    }
    close(fds[1]);
    if (read(fds[0], buffer, sizeof buffer) != 5 || memcmp(buffer, "child", 5)) return 14;
    close(fds[0]);
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) != 23) return 15;
    return 0;
}
