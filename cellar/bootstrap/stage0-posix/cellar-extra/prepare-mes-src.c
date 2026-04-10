/* SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * prepare-mes-src: prepare the GNU Mes source tree for mescc compilation.
 *
 * Must be invoked from the output directory (e.g. via chdirenv).
 *
 * Usage: prepare-mes-src <srcdir> <replace> <cp> <mkdir> <rm> <mes_cpu> <version>
 *
 * Steps:
 *   1. Copy source tree from srcdir into CWD
 *   2. Generate include/mes/config.h
 *   3. Copy arch-specific headers to include/arch/
 *   4. Fix broken symlinks in mes/module/
 *   5. Generate bin/mescc.scm from scripts/mescc.scm.in
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "M2libc/bootstrappable.h"

#define MAX_PATH 4096

void run_cmd(char* tool, char** args)
{
	int pid = fork();
	if(pid == 0)
	{
		execve(tool, args, NULL);
		fputs("execve failed: ", stderr);
		fputs(tool, stderr);
		fputc('\n', stderr);
		exit(EXIT_FAILURE);
	}
	int status = 0;
	waitpid(pid, &status, 0);
	if(status != 0)
	{
		fputs("command failed: ", stderr);
		fputs(tool, stderr);
		fputc('\n', stderr);
		exit(EXIT_FAILURE);
	}
}

char* join_path(char* a, char* b)
{
	char* result = calloc(MAX_PATH, sizeof(char));
	require(result != NULL, "join_path: calloc failed\n");
	strcpy(result, a);
	strcat(result, "/");
	strcat(result, b);
	return result;
}

void write_config_h(char* version)
{
	FILE* f = fopen("include/mes/config.h", "w");
	require(f != NULL, "Failed to open include/mes/config.h for writing\n");
	fputs("#undef SYSTEM_LIBC\n", f);
	fputs("#define MES_VERSION \"", f);
	fputs(version, f);
	fputs("\"\n", f);
	fclose(f);
}

int file_exists(char* path)
{
	FILE* f = fopen(path, "r");
	if(f == NULL) return FALSE;
	fclose(f);
	return TRUE;
}

void copy_recursive(char* srcdir)
{
	char* src_dot = join_path(srcdir, ".");
	char** args = calloc(5, sizeof(char*));
	require(args != NULL, "calloc failed\n");
	args[0] = "/usr/bin/cp";
	args[1] = "-r";
	args[2] = src_dot;
	args[3] = ".";
	args[4] = NULL;
	run_cmd("/usr/bin/cp", args);
	free(src_dot);
	free(args);
}

void run_mkdir(char* mkdir_tool, char* dir)
{
	char** args = calloc(4, sizeof(char*));
	require(args != NULL, "calloc failed\n");
	args[0] = mkdir_tool;
	args[1] = "-p";
	args[2] = dir;
	args[3] = NULL;
	run_cmd(mkdir_tool, args);
	free(args);
}

void run_cp(char* cp_tool, char* src, char* dst)
{
	char** args = calloc(4, sizeof(char*));
	require(args != NULL, "calloc failed\n");
	args[0] = cp_tool;
	args[1] = src;
	args[2] = dst;
	args[3] = NULL;
	run_cmd(cp_tool, args);
	free(args);
}

void run_rm(char* rm_tool, char* path)
{
	char** args = calloc(3, sizeof(char*));
	require(args != NULL, "calloc failed\n");
	args[0] = rm_tool;
	args[1] = path;
	args[2] = NULL;
	run_cmd(rm_tool, args);
	free(args);
}

void run_replace(char* replace_tool, char* file, char* match_on, char* replace_with)
{
	char** args = calloc(10, sizeof(char*));
	require(args != NULL, "calloc failed\n");
	args[0] = replace_tool;
	args[1] = "--file";
	args[2] = file;
	args[3] = "--output";
	args[4] = file;
	args[5] = "--match-on";
	args[6] = match_on;
	args[7] = "--replace-with";
	args[8] = replace_with;
	args[9] = NULL;
	run_cmd(replace_tool, args);
	free(args);
}

int main(int argc, char** argv)
{
	if(argc != 8)
	{
		fputs("Usage: prepare-mes-src <srcdir> <replace> <cp> <mkdir> <rm> <mes_cpu> <version>\n", stderr);
		fputs("Must be run from the output directory (via chdirenv).\n", stderr);
		exit(EXIT_FAILURE);
	}

	char* srcdir = argv[1];
	char* replace_tool = argv[2];
	char* cp_tool = argv[3];
	char* mkdir_tool = argv[4];
	char* rm_tool = argv[5];
	char* mes_cpu = argv[6];
	char* version = argv[7];

	/* Get CWD as the prefix -- chdirenv already cd'd us into the output
	 * directory, so CWD is the MES_PREFIX path that compile rules will use. */
	char* prefix = calloc(MAX_PATH, sizeof(char));
	require(prefix != NULL, "calloc failed\n");
	getcwd(prefix, MAX_PATH);
	require(!match("", prefix), "getcwd() failed\n");

	/* Step 1: Copy source tree into CWD (the output directory) */
	copy_recursive(srcdir);

	/* Step 2: Generate config.h */
	write_config_h(version);

	/* Step 3: Copy arch-specific headers to include/arch/ */
	run_mkdir(mkdir_tool, "include/arch");

	char* arch_syscall = join_path("include/linux", join_path(mes_cpu, "syscall.h"));
	run_cp(cp_tool, arch_syscall, "include/arch/syscall.h");

	char* arch_kstat = join_path("include/linux", join_path(mes_cpu, "kernel-stat.h"));
	if(file_exists(arch_kstat))
	{
		run_cp(cp_tool, arch_kstat, "include/arch/kernel-stat.h");
	}

	char* arch_signal = join_path("include/linux", join_path(mes_cpu, "signal.h"));
	if(file_exists(arch_signal))
	{
		run_cp(cp_tool, arch_signal, "include/arch/signal.h");
	}

	/* Step 4: Fix symlinks in mes/module/ */
	if(file_exists("mes/module/mes/psyntax.pp"))
	{
		run_rm(rm_tool, "mes/module/mes/psyntax.pp");
	}
	if(file_exists("mes/module/mes/psyntax.pp.header"))
	{
		run_rm(rm_tool, "mes/module/mes/psyntax.pp.header");
	}
	if(file_exists("mes/module/srfi/srfi-9.mes"))
	{
		run_rm(rm_tool, "mes/module/srfi/srfi-9.mes");
	}
	if(file_exists("mes/module/srfi/srfi-9/gnu.mes"))
	{
		run_rm(rm_tool, "mes/module/srfi/srfi-9/gnu.mes");
	}
	run_cp(cp_tool, "mes/module/srfi/srfi-9-struct.mes", "mes/module/srfi/srfi-9.mes");
	run_cp(cp_tool, "mes/module/srfi/srfi-9/gnu-struct.mes", "mes/module/srfi/srfi-9/gnu.mes");

	/* Step 5: Generate bin/mescc.scm from template */
	run_mkdir(mkdir_tool, "bin");
	run_cp(cp_tool, "scripts/mescc.scm.in", "bin/mescc.scm");

	run_replace(replace_tool, "bin/mescc.scm", "@prefix@", prefix);
	run_replace(replace_tool, "bin/mescc.scm", "@VERSION@", version);
	run_replace(replace_tool, "bin/mescc.scm", "@mes_cpu@", mes_cpu);
	run_replace(replace_tool, "bin/mescc.scm", "@mes_kernel@", "linux");

	return EXIT_SUCCESS;
}
