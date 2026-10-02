// SPDX-FileCopyrightText: 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <errno.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 3) return 2;
    if ((mkdir(argv[1], 0755) && errno != EEXIST) || chdir(argv[1])) {
        perror(argv[1]);
        return 1;
    }
    execv(argv[2], argv + 2);
    perror(argv[2]);
    return 127;
}
