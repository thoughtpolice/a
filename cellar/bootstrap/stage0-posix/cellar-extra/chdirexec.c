/* SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * chdirexec: change directory, then exec a command with an empty environment.
 *
 * Usage: chdirexec <dir> <command> [args...]
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include "M2libc/bootstrappable.h"

int main(int argc, char** argv)
{
    if (argc < 3) {
        fputs("Usage: chdirexec <dir> <command> [args...]\n", stderr);
        exit(EXIT_FAILURE);
    }

    if (0 > chdir(argv[1])) {
        fputs("Failed to change directory\n", stderr);
        exit(EXIT_FAILURE);
    }

    return execve(argv[2], argv + sizeof(char *) + sizeof(char *), NULL);
}
