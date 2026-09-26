/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runs TARGET, the program in the launcher's own directory, under the name
 * the launcher was run by. Clang takes its driver mode and llvm-ar its
 * ranlib mode from that name, and both find their files from their own
 * executable, so a launcher named clang++ or llvm-ranlib stands in for a
 * second copy of the program. The launcher finds its directory from the
 * path the kernel executed, with symlinks resolved, which needs no /proc,
 * as a build action's empty root has none.
 */
#define _DEFAULT_SOURCE
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/auxv.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    char path[PATH_MAX];
    const char *executed = (const char *)getauxval(AT_EXECFN);
    if (!executed || !realpath(executed, path)) {
        perror(executed ? executed : "AT_EXECFN");
        return 127;
    }
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
