/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runs TARGET, the program in the launcher's own directory, under the name
 * the launcher was run by. Clang takes its driver mode and llvm-ar its
 * ranlib mode from that name, and both find their files from their own
 * executable, so a launcher named clang++ or llvm-ranlib stands in for a
 * second copy of the program.
 */
#define _POSIX_C_SOURCE 200809L
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    char path[PATH_MAX];
    ssize_t length = readlink("/proc/self/exe", path, sizeof path);
    if (length < 0 || (size_t)length >= sizeof path) {
        perror("/proc/self/exe");
        return 127;
    }
    path[length] = '\0';
    char *name = strrchr(path, '/') + 1;
    if ((size_t)(name - path) + sizeof TARGET > sizeof path) {
        fprintf(stderr, "%s: path too long\n", path);
        return 127;
    }
    memcpy(name, TARGET, sizeof TARGET);
    (void)argc;
    execv(path, argv);
    perror(path);
    return 127;
}
