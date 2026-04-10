/* SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * envexec: set environment variables then exec a command.
 *
 * Usage: envexec VAR1=val1 VAR2=val2 ... -- command [args...]
 *
 * Arguments before "--" are environment variable assignments (KEY=VALUE).
 * The command after "--" is executed with those variables in its environment.
 */

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include "M2libc/bootstrappable.h"

#define MAX_ENV 64

int main(int argc, char** argv)
{
	if(argc < 4)
	{
		fputs("Usage: envexec VAR=val ... -- command [args...]\n", stderr);
		exit(EXIT_FAILURE);
	}

	/* Find the "--" separator */
	int sep = 0;
	int i;
	for(i = 1; i < argc; i = i + 1)
	{
		if(match("--", argv[i]))
		{
			sep = i;
			break;
		}
	}

	if(sep == 0)
	{
		fputs("envexec: missing '--' separator\n", stderr);
		exit(EXIT_FAILURE);
	}

	if(sep + 1 >= argc)
	{
		fputs("envexec: no command after '--'\n", stderr);
		exit(EXIT_FAILURE);
	}

	/* Build environment array from VAR=val args (indices 1..sep-1) */
	int env_count = sep - 1;
	require(env_count < MAX_ENV, "envexec: too many environment variables\n");
	char** envp = calloc(env_count + 1, sizeof(char*));
	require(envp != NULL, "envexec: calloc failed\n");
	for(i = 0; i < env_count; i = i + 1)
	{
		envp[i] = argv[i + 1];
	}
	envp[env_count] = NULL;

	/* Build command argument array (indices sep+1..argc-1) */
	int cmd_argc = argc - sep - 1;
	char** cmd_argv = calloc(cmd_argc + 1, sizeof(char*));
	require(cmd_argv != NULL, "envexec: calloc failed\n");
	for(i = 0; i < cmd_argc; i = i + 1)
	{
		cmd_argv[i] = argv[sep + 1 + i];
	}
	cmd_argv[cmd_argc] = NULL;

	execve(cmd_argv[0], cmd_argv, envp);

	fputs("envexec: execve failed for: ", stderr);
	fputs(cmd_argv[0], stderr);
	fputc('\n', stderr);
	return EXIT_FAILURE;
}
