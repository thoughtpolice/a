/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Give a declared source tree a stable name in an action's writable directory.
 * The caller declares the tree and executes this helper inside its own output.
 */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include "M2libc/bootstrappable.h"

extern char **_envp;

int main(int argc, char **argv)
{
    require(argc >= 3, "Usage: source-alias tree program [args...]\n");
    require(symlink(argv[1], "source") == 0, "source-alias: cannot create source link\n");
    execve(argv[2], argv + 2 * sizeof(char *), _envp);
    fputs("source-alias: exec failed\n", stderr);
    return 127;
}
