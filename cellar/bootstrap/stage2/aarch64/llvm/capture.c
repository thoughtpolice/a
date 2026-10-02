// SPDX-FileCopyrightText: 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 3) return 2;
    int fd = open(argv[1], O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0 || dup2(fd, STDOUT_FILENO) < 0) {
        perror(argv[1]);
        return 1;
    }
    if (fd != STDOUT_FILENO) close(fd);
    execv(argv[2], argv + 2);
    perror(argv[2]);
    return 127;
}
