/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Assert a child's exit status, preserving the explicitly supplied environment.
 * With --passed, write "passed" to the given file once the status matches, so
 * a build action can record the check for a test to compare.
 * M2 uses byte offsets for pointer arithmetic, including char ** arguments.
 */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include "M2libc/bootstrappable.h"

extern char **_envp;

int main(int argc, char **argv)
{
    int i = 1;
    char *passed = NULL;
    if(argc > 2)
    {
        if(match(argv[1], "--passed"))
        {
            passed = argv[2];
            i = 3;
        }
    }
    require(argc >= i + 2, "Usage: expect-exit [--passed file] status program [args...]\n");
    int expected = strtoint(argv[i]);
    require(expected >= 0, "expect-exit: invalid status\n");
    require(expected <= 255, "expect-exit: invalid status\n");
    i = i + 1;
    int pid = fork();
    require(pid >= 0, "expect-exit: fork failed\n");
    if(pid == 0)
    {
        execve(argv[i], argv + i * sizeof(char *), _envp);
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
    if(passed)
    {
        FILE *result = fopen(passed, "w");
        require(result != NULL, "expect-exit: cannot write the result\n");
        fputs("passed\n", result);
        fclose(result);
    }
    return 0;
}
