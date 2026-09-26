/* SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * bytecmp: compare two files byte-by-byte.
 *
 * Usage: bytecmp <file1> <file2>
 *
 * Exits 0 if the files are identical, 1 if they differ.
 */

#include <stdio.h>
#include <stdlib.h>
#include "M2libc/bootstrappable.h"

int file_size(char* path)
{
	FILE* f = fopen(path, "r");
	if(f == NULL) return -1;
	int n = 0;
	while(fgetc(f) != EOF)
	{
		n = n + 1;
	}
	fclose(f);
	return n;
}

int main(int argc, char** argv)
{
	if(argc != 3)
	{
		fputs("Usage: bytecmp <file1> <file2>\n", stderr);
		exit(EXIT_FAILURE);
	}

	fputs("bytecmp: comparing files\n", stdout);
	fputs("  a: ", stdout);
	fputs(argv[1], stdout);
	fputc('\n', stdout);
	fputs("  b: ", stdout);
	fputs(argv[2], stdout);
	fputc('\n', stdout);

	FILE* a = fopen(argv[1], "r");
	if(a == NULL)
	{
		fputs("Failed to open: ", stderr);
		fputs(argv[1], stderr);
		fputc('\n', stderr);
		exit(EXIT_FAILURE);
	}

	FILE* b = fopen(argv[2], "r");
	if(b == NULL)
	{
		fputs("Failed to open: ", stderr);
		fputs(argv[2], stderr);
		fputc('\n', stderr);
		fclose(a);
		exit(EXIT_FAILURE);
	}

	int offset = 0;
	int ca;
	int cb;
	ca = fgetc(a);
	cb = fgetc(b);
	while(ca == cb)
	{
		if(ca == EOF) break;
		offset = offset + 1;
		ca = fgetc(a);
		cb = fgetc(b);
	}

	fclose(a);
	fclose(b);

	if(ca != cb)
	{
		fputs("FAIL: files differ at byte offset ", stdout);
		fputs(int2str(offset, 10, 0), stdout);
		fputc('\n', stdout);

		if(ca == EOF)
		{
			fputs("  a: EOF (shorter file)\n", stdout);
		}
		else
		{
			fputs("  a: 0x", stdout);
			fputs(int2str(ca, 16, 0), stdout);
			fputc('\n', stdout);
		}

		if(cb == EOF)
		{
			fputs("  b: EOF (shorter file)\n", stdout);
		}
		else
		{
			fputs("  b: 0x", stdout);
			fputs(int2str(cb, 16, 0), stdout);
			fputc('\n', stdout);
		}

		/* Print file sizes for context */
		int size_a = file_size(argv[1]);
		int size_b = file_size(argv[2]);
		fputs("  size a: ", stdout);
		fputs(int2str(size_a, 10, 0), stdout);
		fputs(" bytes\n", stdout);
		fputs("  size b: ", stdout);
		fputs(int2str(size_b, 10, 0), stdout);
		fputs(" bytes\n", stdout);

		return EXIT_FAILURE;
	}

	fputs("PASS: files are byte-identical (", stdout);
	fputs(int2str(offset, 10, 0), stdout);
	fputs(" bytes)\n", stdout);
	return EXIT_SUCCESS;
}
