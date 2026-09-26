/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 * Add declared environment values without discarding the action environment.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    int i;
    char *equal;
    for (i = 1; i < argc && strcmp(argv[i], "--"); i++) {
        equal = strchr(argv[i], '=');
        if (!equal || equal == argv[i]) return 1;
        *equal = 0;
        if (setenv(argv[i], equal + 1, 1)) { perror("setenv"); return 1; }
    }
    if (i + 1 >= argc) return 1;
    execv(argv[i + 1], argv + i + 1);
    perror(argv[i + 1]);
    return 127;
}
