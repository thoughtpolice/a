/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * answer-test: discovery and execution harness for stage0 answer files.
 *
 * Usage:
 *   answer-test --list <answers>
 *   answer-test --check <sha256sum> '<hash>  <path>'
 *
 * Listing streams an answers file to stdout. Checking prints the selected
 * golden entry, then replaces this process with sha256sum for that entry's
 * path. Buck2's internal test runner compares the two output lines.
 */

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "M2libc/bootstrappable.h"

#define BUFFER_SIZE 4096

int list_answers(char* path)
{
	int input = open(path, O_RDONLY, 0);
	if(-1 == input)
	{
		fputs("answer-test: unable to open answers file: ", stderr);
		fputs(path, stderr);
		fputc('\n', stderr);
		return EXIT_FAILURE;
	}

	char* buffer = calloc(BUFFER_SIZE, sizeof(char));
	require(buffer != NULL, "answer-test: calloc failed\n");

	int bytes;
	while(0 < (bytes = read(input, buffer, BUFFER_SIZE)))
	{
		if(bytes != write(1, buffer, bytes))
		{
			fputs("answer-test: unable to write answers\n", stderr);
			return EXIT_FAILURE;
		}
	}

	if(0 > bytes)
	{
		fputs("answer-test: unable to read answers\n", stderr);
		return EXIT_FAILURE;
	}

	return EXIT_SUCCESS;
}

int check_answer(char* sha256sum, char* answer)
{
	if((67 > strlen(answer)) || (' ' != answer[64]) || (' ' != answer[65]))
	{
		fputs("answer-test: malformed answer\n", stderr);
		return EXIT_FAILURE;
	}

	write(1, answer, strlen(answer));
	write(1, "\n", 1);

	char** args = calloc(3, sizeof(char*));
	require(args != NULL, "answer-test: calloc failed\n");
	args[0] = sha256sum;
	args[1] = answer + 66;
	args[2] = NULL;

	execve(sha256sum, args, NULL);
	fputs("answer-test: unable to execute sha256sum: ", stderr);
	fputs(sha256sum, stderr);
	fputc('\n', stderr);
	return EXIT_FAILURE;
}

int main(int argc, char** argv)
{
	if((3 == argc) && match("--list", argv[1]))
	{
		return list_answers(argv[2]);
	}

	if((4 == argc) && match("--check", argv[1]))
	{
		return check_answer(argv[2], argv[3]);
	}

	fputs("Usage: answer-test --list <answers>\n", stderr);
	fputs("       answer-test --check <sha256sum> '<hash>  <path>'\n", stderr);
	return EXIT_FAILURE;
}
