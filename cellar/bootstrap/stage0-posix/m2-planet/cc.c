/* Copyright (C) 2016 Jeremiah Orians
 * Copyright (C) 2020 deesix <deesix@tuta.io>
 * This file is part of M2-Planet.
 *
 * M2-Planet is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * M2-Planet is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with M2-Planet.  If not, see <http://www.gnu.org/licenses/>.
 */
#include<stdlib.h>
#include<stdio.h>
#include<string.h>
#include"cc.h"

/* The core functions */
void initialize_types(void);
struct token_list* read_all_tokens(FILE* a, struct token_list* current, char* filename);
struct token_list* reverse_list(struct token_list* head);

struct token_list* remove_line_comments(struct token_list* head);
struct token_list* remove_line_comment_tokens(struct token_list* head);
struct token_list* remove_preprocessor_directives(struct token_list* head);

void eat_newline_tokens(void);
void init_macro_env(char* sym, char* value, char* source, int num);
void preprocess(void);
void program(void);
void recursive_output(struct token_list* i, FILE* out);
void output_tokens(struct token_list *i, FILE* out);
int strtoint(char *a);

int main(int argc, char** argv)
{
	MAX_STRING = 4096;
	BOOTSTRAP_MODE = FALSE;
	PREPROCESSOR_MODE = FALSE;
	FOLLOW_INCLUDES = FALSE;
	int DEBUG = FALSE;
	FILE* in = stdin;
	FILE* destination_file = stdout;
	Architecture = 0; /* catch unset */

	/* These need to be here instead of defines
	 * since cc_* can't handle string constants. */
	char* m2_major = "1";
	char* m2_minor = "12";
	char* m2_patch = "1";

	init_macro_env("__M2__", "42", "__INTERNAL_M2__", 0); /* Setup __M2__ */
	init_macro_env("__M2C__", m2_major, "__INTERNAL_M2__", 0);
	init_macro_env("__M2C_MINOR__", m2_minor, "__INTERNAL_M2__", 0);
	init_macro_env("__M2C_PATCHLEVEL__", m2_patch, "__INTERNAL_M2__", 0);

	/* The standard allows an implementation defined valid value
	 * if time and date are not available. */
	/* Since we're modifying the tokens directly we don't need closing quotes */
	init_macro_env("__DATE__", "\"Jan  1 1970", "__C_STANDARD__", 0);
	init_macro_env("__TIME__", "\"00:00:00", "__C_STANDARD__", 0);

	init_macro_env("__STDC__", "1", "__C_STANDARD__", 0);
	init_macro_env("__STDC_HOSTED__", "1", "__C_STANDARD__", 0);
	/* Claim support for C89 despite us supporting some newer features.
	 * We are not close to fully supporting any standard so claim the one with least features. */
	init_macro_env("__STDC_VERSION__", "199409", "__C_STANDARD__", 0);

	char* arch;
	char* name;
	char* hold;
	int env=0;
	char* val;
	struct include_path_list* path;
	struct include_path_list* end;

	int i = 1;
	while(i <= argc)
	{
		if(NULL == argv[i])
		{
			i = i + 1;
		}
		else if(match(argv[i], "-o") || match(argv[i], "--output"))
		{
			destination_file = fopen(argv[i + 1], "w");
			if(NULL == destination_file)
			{
				fputs("Unable to open for writing file: ", stderr);
				fputs(argv[i + 1], stderr);
				fputs("\n Aborting to avoid problems\n", stderr);
				exit(EXIT_FAILURE);
			}
			i = i + 2;
		}
		else if(match(argv[i], "-A") || match(argv[i], "--architecture"))
		{
			arch = argv[i + 1];
			if(match("knight-native", arch)) {
				Architecture = KNIGHT_NATIVE;
				init_macro_env("__knight__", "1", "--architecture", env);
				env = env + 1;
			}
			else if(match("knight-posix", arch)) {
				Architecture = KNIGHT_POSIX;
				init_macro_env("__knight_posix__", "1", "--architecture", env);
				env = env + 1;
			}
			else if(match("x86", arch))
			{
				Architecture = X86;
				init_macro_env("__i386__", "1", "--architecture", env);
				env = env + 1;
			}
			else if(match("amd64", arch))
			{
				Architecture = AMD64;
				init_macro_env("__x86_64__", "1", "--architecture", env);
				env = env + 1;
			}
			else if(match("armv7l", arch))
			{
				Architecture = ARMV7L;
				init_macro_env("__arm__", "1", "--architecture", env);
				env = env + 1;
			}
			else if(match("aarch64", arch))
			{
				Architecture = AARCH64;
				init_macro_env("__aarch64__", "1", "--architecture", env);
				env = env + 1;
			}
			else if(match("riscv32", arch))
			{
				Architecture = RISCV32;
				init_macro_env("__riscv", "1", "--architecture", env);
				init_macro_env("__riscv_xlen", "32", "--architecture", env + 1);
				env = env + 2;
			}
			else if(match("riscv64", arch))
			{
				Architecture = RISCV64;
				init_macro_env("__riscv", "1", "--architecture", env);
				init_macro_env("__riscv_xlen", "64", "--architecture", env + 1);
				env = env + 2;
			}
			else
			{
				fputs("Unknown architecture: ", stderr);
				fputs(arch, stderr);
				fputs(" know values are: knight-native, knight-posix, x86, amd64, armv7l, aarch64, riscv32 and riscv64\n", stderr);
				exit(EXIT_FAILURE);
			}
			i = i + 2;
		}
		else if(match(argv[i], "--max-string"))
		{
			hold = argv[i+1];
			if(NULL == hold)
			{
				fputs("--max-string requires a numeric argument\n", stderr);
				exit(EXIT_FAILURE);
			}
			MAX_STRING = strtoint(hold);
			require(0 < MAX_STRING, "Not a valid string size\nAbort and fix your --max-string\n");
			i = i + 2;
		}
		else if(match(argv[i], "--bootstrap-mode"))
		{
			BOOTSTRAP_MODE = TRUE;
			i = i + 1;
		}
		else if(match(argv[i], "-g") || match(argv[i], "--debug"))
		{
			DEBUG = TRUE;
			i = i + 1;
		}
		else if(match(argv[i], "-h") || match(argv[i], "--help"))
		{
			fputs("Usage: M2-Planet [options] file...\n", stdout);
			fputs("Options:\n", stdout);
			fputs(" --file,-f                      input file\n", stdout);
			fputs(" --output,-o                    output file\n", stdout);
			fputs(" --architecture,-A ARCHITECTURE Target architecture. Call without argument to list available\n", stdout);
			fputs(" -D                             Add define\n", stdout);
			fputs(" -E                             Preprocess only\n", stdout);
			fputs(" --expand-includes              Enable resolving #includes\n", stdout);
			fputs(" -I DIR                         Add DIR to include search path\n", stdout);
			fputs(" --debug,-g                     Debug mode\n", stdout);
			fputs(" --bootstrap-mode               Emulate less powerful cc_* compilers\n", stdout);
			fputs(" --max-string N                 Size of maximum string value (default 4096)\n", stdout);
			fputs(" --help,-h                      Display this message\n", stdout);
			fputs(" --version,-V                   Display compiler version\n", stdout);
			exit(EXIT_SUCCESS);
		}
		else if(match(argv[i], "--expand-includes"))
		{
			FOLLOW_INCLUDES = TRUE;
			i = i + 1;
		}
		else if(match(argv[i], "-E"))
		{
			PREPROCESSOR_MODE = TRUE;
			i = i + 1;
		}
		else if(match(argv[i], "-D"))
		{
			val = argv[i+1];
			if(NULL == val)
			{
				fputs("-D requires an argument", stderr);
				exit(EXIT_FAILURE);
			}
			while(0 != val[0])
			{
				if('=' == val[0])
				{
					val[0] = 0;
					val = val + 1;
					break;
				}
				val = val + 1;
			}
			init_macro_env(argv[i+1], val, "__ARGV__", env);
			env = env + 1;
			i = i + 2;
		}
		else if(match(argv[i], "-V") || match(argv[i], "--version"))
		{
			fputs("M2-Planet v", stderr);
			fputs(m2_major, stderr);
			fputs(".", stderr);
			fputs(m2_minor, stderr);
			fputs(".", stderr);
			fputs(m2_patch, stderr);
			fputs("\n", stderr);
			exit(EXIT_SUCCESS);
		}
		else if(match(argv[i], "-I"))
		{
			i = i + 1;

			path = calloc(1, sizeof(struct include_path_list));
			path->path = argv[i];

			if(argv[i] == NULL)
			{
				fputs("-I requires an argument\n", stderr);
				exit(EXIT_FAILURE);
			}

			/* We want the first path on the CLI to be the first path checked so it needs to be in the proper order. */
			if(include_paths == NULL)
			{
				include_paths = path;
			}
			else
			{
				end = include_paths;
				while(end->next != NULL)
				{
					end = end->next;
				}
				end->next = path;
			}

			i = i + 1;
		}
		else
		{
			if(match(argv[i], "-f") || match(argv[i], "--file"))
			{
				i = i + 1;
			}

			name = argv[i];
			if(NULL == hold_string)
			{
				hold_string = calloc(MAX_STRING + 4, sizeof(char));
				require(NULL != hold_string, "Impossible Exhaustion has occurred\n");
			}

			if(NULL == name)
			{
				fputs("did not receive a filename\n", stderr);
				exit(EXIT_FAILURE);
			}

			in = fopen(name, "r");
			if(NULL == in)
			{
				fputs("Unable to open for reading file: ", stderr);
				fputs(name, stderr);
				fputs("\n Aborting to avoid problems\n", stderr);
				exit(EXIT_FAILURE);
			}
			global_token = read_all_tokens(in, global_token, name);
			fclose(in);

			i = i + 1;
		}
	}

	/* Deal with special case of architecture not being set */
	if(0 == Architecture)
	{
		Architecture = KNIGHT_NATIVE;
		init_macro_env("__knight__", "1", "--architecture", env);
	}

	if(Architecture == KNIGHT_NATIVE
		|| Architecture == KNIGHT_POSIX)
	{
		stack_direction = STACK_DIRECTION_PLUS;
	}
	else
	{
		stack_direction = STACK_DIRECTION_MINUS;
	}

	/* Deal with special case of wanting to read from standard input */
	if(stdin == in)
	{
		hold_string = calloc(MAX_STRING + 4, sizeof(char));
		require(NULL != hold_string, "Impossible Exhaustion has occurred\n");
		global_token = read_all_tokens(in, global_token, "STDIN");
	}

	if(NULL == global_token)
	{
		fputs("Either no input files were given or they were empty\n", stderr);
		exit(EXIT_FAILURE);
	}
	global_token = reverse_list(global_token);

	if (BOOTSTRAP_MODE)
	{
		global_token = remove_line_comment_tokens(global_token);
		global_token = remove_preprocessor_directives(global_token);
	}
	else
	{
		global_token = remove_line_comments(global_token);
		preprocess();
	}

	if (PREPROCESSOR_MODE)
	{
		fputs("\n/* Preprocessed source */\n", destination_file);
		output_tokens(global_token, destination_file);
		goto exit_success;
	}

	/* the main parser doesn't know how to handle newline tokens */
	eat_newline_tokens();

	initialize_types();
	reset_hold_string();
	output_list = NULL;
	program();

	/* Output the program we have compiled */
	fputs("\n# Core program\n", destination_file);
	recursive_output(output_list, destination_file);
	if(KNIGHT_NATIVE == Architecture) fputs("\n", destination_file);
	else if(DEBUG) fputs("\n:ELF_data\n", destination_file);
	fputs("\n# Program global variables\n", destination_file);
	recursive_output(globals_list, destination_file);
	fputs("\n# Program strings\n", destination_file);
	recursive_output(strings_list, destination_file);
	if(KNIGHT_NATIVE == Architecture) fputs("\n:STACK\n", destination_file);
	else if(!DEBUG) fputs("\n:ELF_end\n", destination_file);

exit_success:
	if (destination_file != stdout)
	{
		fclose(destination_file);
	}
	return EXIT_SUCCESS;
}
