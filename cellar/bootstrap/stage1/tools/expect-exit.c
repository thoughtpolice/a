/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Assert a child's exit status, preserving the explicitly supplied environment.
 * M2 uses byte offsets for pointer arithmetic, including char ** arguments.
 */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include "M2libc/bootstrappable.h"

extern char **_envp;

int main(int argc, char **argv)
{
    require(argc >= 3, "Usage: expect-exit status program [args...]\n");
    int expected = strtoint(argv[1]);
    require(expected >= 0, "expect-exit: invalid status\n");
    require(expected <= 255, "expect-exit: invalid status\n");
    int pid = fork();
    require(pid >= 0, "expect-exit: fork failed\n");
    if(pid == 0)
    {
        execve(argv[2], argv + 2 * sizeof(char *), _envp);
        fputs("expect-exit: exec failed\n", stderr);
        _exit(127);
    }
    int status = 0;
    require(waitpid(pid, &status, 0) == pid, "expect-exit: wait failed\n");
    if(status != expected * 256)
    {
        fputs("expect-exit: unexpected wait status ", stderr);
        fputs(int2str(status, 10, 0), stderr);
        fputc('\n', stderr);
        return 1;
    }
    return 0;
}
