/* SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * chdirenv: like chdirexec but preserves the process environment.
 *
 * Usage: chdirenv <dir> <command> [args...]
 *
 * Creates <dir> if it does not exist, changes to it, then executes
 * <command> with [args...], passing through the current environment
 * (unlike chdirexec which clears the environment by passing NULL to
 * execve).
 */

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/stat.h>
#include "M2libc/bootstrappable.h"

extern char** _envp;

int main(int argc, char** argv)
{
	if(argc < 3)
	{
		fputs("Usage: chdirenv <dir> <command> [args...]\n", stderr);
		exit(EXIT_FAILURE);
	}

	/* Create the directory if it does not exist (Buck2 does not
	 * pre-create dir=True output directories). */
	mkdir(argv[1], 0755);

	if(0 > chdir(argv[1]))
	{
		fputs("Failed to change directory to: ", stderr);
		fputs(argv[1], stderr);
		fputc('\n', stderr);
		exit(EXIT_FAILURE);
	}

	return execve(argv[2], argv + sizeof(char *) + sizeof(char *), _envp);
}
