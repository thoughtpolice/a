/* Copyright (C) 2024 Austin Seipp
 * This file is part of mescc-tools
 *
 * mescc-tools is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * mescc-tools is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with mescc-tools.  If not, see <http://www.gnu.org/licenses/>.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include "M2libc/bootstrappable.h"

// Usage: chdirexec <dir> <command> [args...]
//
// Change to directory <dir> then execute <command> with [args...]
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
