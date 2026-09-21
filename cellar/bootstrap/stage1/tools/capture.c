/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Redirect stdout to a declared artifact and execute a bootstrapped generator.
 * Standard input and error must be open, as they are in Buck actions.
 */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include "M2libc/bootstrappable.h"

extern char **_envp;

int main(int argc, char **argv)
{
    require(argc >= 3, "Usage: capture output program [args...]\n");
    close(1);
    int fd = open(argv[1], O_WRONLY | O_CREAT | O_TRUNC, 0644);
    require(fd == 1, "capture: cannot open standard output\n");
    execve(argv[2], argv + 2 * sizeof(char *), _envp);
    fputs("capture: exec failed\n", stderr);
    return 127;
}
