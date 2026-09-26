/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Redirect stdout to a declared artifact and execute a bootstrapped generator.
 * Optionally redirect stdin and enter a declared input directory. The output
 * is opened before changing directory; only the child command is relative to it.
 */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include "M2libc/bootstrappable.h"

extern char **_envp;

int main(int argc, char **argv)
{
    int i = 1;
    int fd;
    char *input = NULL;
    char *directory = NULL;
    while(i < argc)
    {
        if(match(argv[i], "--stdin"))
        {
            require(i + 1 < argc, "capture: missing input\n");
            input = argv[i + 1];
        }
        else if(match(argv[i], "--cwd"))
        {
            require(i + 1 < argc, "capture: missing directory\n");
            directory = argv[i + 1];
        }
        else break;
        i = i + 2;
    }
    require(argc >= i + 2, "Usage: capture [--stdin file] [--cwd dir] output program [args...]\n");
    if(input)
    {
        close(0);
        fd = open(input, O_RDONLY, 0);
        require(fd == 0, "capture: cannot open standard input\n");
    }
    close(1);
    fd = open(argv[i], O_WRONLY | O_CREAT | O_TRUNC, 0644);
    require(fd == 1, "capture: cannot open standard output\n");
    if(directory) require(chdir(directory) == 0, "capture: cannot change directory\n");
    i = i + 1;
    execve(argv[i], argv + i * sizeof(char *), _envp);
    fputs("capture: exec failed\n", stderr);
    return 127;
}
