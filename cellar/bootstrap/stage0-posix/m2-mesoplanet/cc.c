/* Copyright (C) 2016, 2021 Jeremiah Orians
 * Copyright (C) 2020 deesix <deesix@tuta.io>
 * Copyright (C) 2020 Gabriel Wicki
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

#include"cc.h"
#include <unistd.h>

/* The core functions */
void populate_env(char** envp);
void setup_env(void);
char* env_lookup(char* variable);
void initialize_types(void);
struct token_list* read_all_tokens(FILE* a, struct token_list* current, char* filename, int include);
struct token_list* reverse_list(struct token_list* head);

void init_macro_env(char* sym, char* value, char* source, int num);
void preprocess(void);
void output_tokens(struct token_list *i, FILE* out);
int strtoint(char *a);
void spawn_processes(int debug_flag, char* prefix, char* preprocessed_file, char* destination, char** envp, int no_c_files);

int follow_includes;

void prechecks(int argc, char** argv)
{
	int env = 0;
	char* hold;
	int i = 1;
	while(i <= argc)
	{
		if(NULL == argv[i])
		{
			i += 1;
		}
		else if(match(argv[i], "--debug-mode"))
		{
			hold = argv[i+1];
			require(NULL != hold, "--debug-mode requires an argument\n");
			DEBUG_LEVEL = strtoint(hold);
			if(0 == DEBUG_LEVEL)
			{
				require(match("0", hold), "--debug-mode values must be numbers\n"
				                          "and level 0 needed to be expressed as 0\n");
			}
			fputs("DEBUG_LEVEL set to: ", stderr);
			fputs(hold, stderr);
			fputc('\n', stderr);
			i+= 2;
		}
		else if(match(argv[i], "-A") || match(argv[i], "--architecture"))
		{
			hold = argv[i+1];
			require(NULL != hold, "--architecture needs to be passed an architecture\n");
			Architecture = hold;
			i += 2;
		}
		else if(match(argv[i], "--os") || match(argv[i], "--operating-system"))
		{
			hold = argv[i+1];
			require(NULL != hold, "--operating-system needs to be passed an operating system\n");
			OperatingSystem = hold;
			i += 2;
		}
		else if(match(argv[i], "--max-string"))
		{
			hold = argv[i+1];
			require(NULL != hold, "--max-string requires a numeric argument\n");
			MAX_STRING = strtoint(hold);
			require(0 < MAX_STRING, "Not a valid string size\nAbort and fix your --max-string\n");
			i += 2;
		}
		else if(match(argv[i], "--no-includes"))
		{
			follow_includes = FALSE;
			i+= 1;
		}
		else if(starts_with(argv[i], "-I"))
		{
			int two_arguments = strlen(argv[i]) == 2;
			if(two_arguments)
			{
				hold = argv[i+1];
			}
			else
			{
				hold = argv[i] + 2;
			}

			if(NULL == hold)
			{
				fputs("-I requires a PATH\n", stderr);
				exit(EXIT_FAILURE);
			}

			struct include_path_list* path = calloc(1, sizeof(struct include_path_list));
			path->path = hold;

			/* We want the first path on the CLI to be the first path checked so it needs to be in the proper order. */
			if(include_paths == NULL)
			{
				include_paths = path;
			}
			else
			{
				include_paths->next = path;
			}

			/* For backwards compatibility the first include path sets M2LIBC_PATH */
			if(M2LIBC_PATH == NULL)
			{
				if(1 <= DEBUG_LEVEL)
				{
					fputs("M2LIBC_PATH set by -I to ", stderr);
					fputs(hold, stderr);
					fputc('\n', stderr);
				}
				M2LIBC_PATH = hold;
			}
			if(two_arguments)
			{
				i += 2;
			}
			else
			{
				i += 1;
			}
		}
		else if(match(argv[i], "-D"))
		{
			hold = argv[i+1];
			if(NULL == hold)
			{
				fputs("-D requires an argument", stderr);
				exit(EXIT_FAILURE);
			}
			while(0 != hold[0])
			{
				if('=' == hold[0])
				{
					hold[0] = 0;
					hold = hold + 1;
					break;
				}
				hold = hold + 1;
			}
			init_macro_env(argv[i+1], hold, "__ARGV__", env);
			env = env + 1;
			i += 2;
		}
		else if(match(argv[i], "-c"))
		{
			OBJECT_FILES_ONLY = TRUE;
			i += 1;
		}
		else
		{
			i += 1;
		}
	}
}

int main(int argc, char** argv, char** envp)
{
	/****************************************************************************
	 * Zero means no debugging messages and larger positive values means more   *
	 * chatty output. Level 15 means EVERYTHING but 7 should cover most magic   *
	 ****************************************************************************/
	DEBUG_LEVEL = 0;
	/* Setup __M2__ (It is very very special *DO NOT MESS WITH IT* ) */
	init_macro_env("__M2__", "__M2__", "__INTERNAL_M2__", 0);

	/* Our fun globals */
	FUZZING = FALSE;
	MAX_STRING = 65536;
	PREPROCESSOR_MODE = FALSE;
	STDIO_USED = FALSE;
	DIRTY_MODE = FALSE;
	Architecture = NULL;
	OperatingSystem = NULL;

	/* Our fun locals */
	int debug_flag = TRUE;
	FILE* in = stdin;
	FILE* tempfile;
	char* destination_name = "a.out";
	FILE* destination_file = stdout;
	char* name;
	char* first_input_filename = NULL;
	int DUMP_MODE = FALSE;
	int explicit_output_file = FALSE;
	follow_includes = TRUE;
	OBJECT_FILES_ONLY = FALSE;

	/* Try to get our needed updates */
	prechecks(argc, argv);

	/* Get the environmental bits */
	if(1 <= DEBUG_LEVEL) fputs("Starting to setup Environment\n", stderr);
	populate_env(envp);
	setup_env();
	if(1 <= DEBUG_LEVEL) fputs("Environment setup\n", stderr);

	/* If this variable is set we treat calling the executable without arguments as an error. */
	if(env_lookup("M2MESOPLANET_NEW_ARGUMENTLESS_BEHAVIOR") != NULL)
	{
		in = NULL;
	}

	M2LIBC_PATH = env_lookup("M2LIBC_PATH");
	if(NULL == M2LIBC_PATH) M2LIBC_PATH = "./M2libc";
	else if(1 <= DEBUG_LEVEL)
	{
		fputs("M2LIBC_PATH set by environment variable to ", stderr);
		fputs(M2LIBC_PATH, stderr);
		fputc('\n', stderr);
	}

	TEMPDIR = env_lookup("TMPDIR");
	if(NULL == TEMPDIR) TEMPDIR = "/tmp";
	else if(1 <= DEBUG_LEVEL)
	{
		fputs("TEMPDIR set by environment variable to ", stderr);
		fputs(TEMPDIR, stderr);
		fputc('\n', stderr);
	}

	int i = 1;
	while(i <= argc)
	{
		if(NULL == argv[i])
		{
			i += 1;
		}
		else if(match(argv[i], "-E") || match(argv[i], "--preprocess-only"))
		{
			PREPROCESSOR_MODE = TRUE;
			i += 1;
		}
		else if(match(argv[i], "--dump-mode"))
		{
			DUMP_MODE = TRUE;
			i+= 1;
		}
		else if(match(argv[i], "--dirty-mode"))
		{
			DIRTY_MODE = TRUE;
			i+= 1;
		}
		else if(match(argv[i], "--no-includes"))
		{
			/* Handled by precheck*/
			i+= 1;
		}
		else if(match(argv[i], "--debug-mode"))
		{
			/* Handled by precheck */
			i+= 2;
		}
		else if(match(argv[i], "-A") || match(argv[i], "--architecture"))
		{
			/* Handled by precheck */
			i += 2;
		}
		else if(match(argv[i], "--os") || match(argv[i], "--operating-system"))
		{
			/* Handled by precheck */
			i += 2;
		}
		else if(match(argv[i], "-o") || match(argv[i], "--output"))
		{
			explicit_output_file = TRUE;

			destination_name = argv[i + 1];
			require(NULL != destination_name, "--output option requires a filename to follow\n");
			destination_file = fopen(destination_name, "w");
			if(NULL == destination_file)
			{
				fputs("Unable to open for writing file: ", stderr);
				fputs(argv[i + 1], stderr);
				fputs("\n Aborting to avoid problems\n", stderr);
				exit(EXIT_FAILURE);
			}
			i += 2;
		}
		else if(match(argv[i], "--max-string"))
		{
			/* handled by precheck */
			i += 2;
		}
		else if(starts_with(argv[i], "-I"))
		{
			/* Handled by precheck */
			if(strlen(argv[i]) > 2)
			{
				/* If path in the same string as -I/mypath/here */
				i += 1;
			}
			else
			{
				i += 2;
			}
		}
		else if(match(argv[i], "-D"))
		{
			/* Handled by precheck */
			i += 2;
		}
		else if(match(argv[i], "-c"))
		{
			/* Handled by precheck */
			i += 1;
		}
		else if(match(argv[i], "-h") || match(argv[i], "--help"))
		{
			fputs("Usage: M2-Mesoplanet [options] file...\n"
				"Options:\n"
				" --file,-f               input file\n"
				" --output,-o             output file\n"
				" --architecture,-A       Target architecture. Use -A to list options\n"
				" --operating-system,--os Target operating system\n"
				" --preprocess-only,-E    Preprocess only\n"
				" --max-string N          Size of maximum string value (default 4096)\n"
				" --no-includes           Disable following include files\n"
				" --debug-mode N          Compiler debug level. 0 is disabled and 15 is max\n"
				" --dump-mode             Dump tokens before preprocessing\n"
				" --dirty-mode            Do not remove temporary files\n"
				" -D                      Add define\n"
				" -c                      Compile and assemble, but do not link.\n"
				" -I                      Add M2libc path. Will override the M2LIBC_PATH environment variable.\n"
				" --fuzz                  Do not execve potentially dangerous inputs\n"
				" --no-debug              Do not output debug info\n"
				" --temp-directory        Directory used for temporary artifacts. Will override TMPDIR env var.\n"
				" --help,-h               Display this message\n"
				" --version,-V            Display compiler version\n", stdout);
			exit(EXIT_SUCCESS);
		}
		else if(match(argv[i], "-V") || match(argv[i], "--version"))
		{
			fputs("M2-Mesoplanet v1.13.0\n", stderr);
			exit(EXIT_SUCCESS);
		}
		else if(match(argv[i], "--fuzz"))
		{
			/* Set fuzzing */
			FUZZING = TRUE;
			i += 1;
		}
		else if(match(argv[i], "--no-debug"))
		{
			/* strip things down */
			debug_flag = FALSE;
			i += 1;
		}
		else if(match(argv[i], "-"))
		{
			in = stdin;
		}
		else if(match(argv[i], "--temp-directory"))
		{
			name = argv[i+1];
			if(NULL == name)
			{
				fputs("--temp-directory requires a PATH\n", stderr);
				exit(EXIT_FAILURE);
			}
			if(1 <= DEBUG_LEVEL)
			{
				fputs("TEMPDIR set by --temp-directory to ", stderr);
				fputs(name, stderr);
				fputc('\n', stderr);
			}
			TEMPDIR = name;
			i += 2;
		}
		else
		{
			if(match(argv[i], "-f") || match(argv[i], "--file"))
			{
				i = i + 1;
			}

			if(NULL == hold_string)
			{
				hold_string = calloc(MAX_STRING + 4, sizeof(char));
				require(NULL != hold_string, "Impossible Exhaustion has occured\n");
			}

			name = argv[i];
			if(NULL == name)
			{
				fputs("did not receive a file name\n", stderr);
				exit(EXIT_FAILURE);
			}

			if(first_input_filename == NULL)
			{
				first_input_filename = name;
			}

			in = fopen(name, "r");
			if(NULL == in)
			{
				fputs("Unable to open for reading file: ", stderr);
				fputs(name, stderr);
				fputs("\n Aborting to avoid problems\n", stderr);
				exit(EXIT_FAILURE);
			}

			if(ends_with(name, ".o"))
			{
				if(1 <= DEBUG_LEVEL) fprintf(stderr, "Object file added: '%s'\n", name);

				struct object_file_list* last = extra_object_files;
				extra_object_files = calloc(1, sizeof(struct object_file_list));
				extra_object_files->file = name;
				extra_object_files->next = last;
			}
			else
			{
				global_token = read_all_tokens(in, global_token, name, follow_includes);
				fclose(in);
			}

			i += 1;
		}
	}

	if(1 <= DEBUG_LEVEL) fputs("READ all files\n", stderr);

	/* Deal with special case of wanting to read from standard input */
	if(stdin == in)
	{
		hold_string = calloc(MAX_STRING, sizeof(char));
		require(NULL != hold_string, "Impossible Exhaustion has occured\n");
		global_token = read_all_tokens(in, global_token, "STDIN", follow_includes);
	}

	if(NULL == global_token && NULL == extra_object_files)
	{
		fputs("Either no input files were given or they were empty\n", stderr);
		exit(EXIT_FAILURE);
	}

	if(1 <= DEBUG_LEVEL) fputs("Start to reverse list\n", stderr);
	global_token = reverse_list(global_token);
	if(1 <= DEBUG_LEVEL) fputs("List reversed\n", stderr);

	if(DUMP_MODE)
	{
		output_tokens(global_token, destination_file);
		exit(EXIT_SUCCESS);
	}

	preprocess();

	if(PREPROCESSOR_MODE)
	{
		fputs("/* M2-Mesoplanet Preprocessed source */\n", destination_file);
		output_tokens(global_token, destination_file);
		fclose(destination_file);
	}
	else
	{
		/* Ensure we can write to the temp directory */
		int permissions = access(TEMPDIR, 0);
		if(0 != permissions)
		{
			fputs("unable to access: ", stderr);
			fputs(TEMPDIR, stderr);
			fputs(" for use as a temp directory\nPlease use --temp-directory to set a directory you can use or set the TMPDIR variable\n", stderr);
			exit(EXIT_FAILURE);
		}

		name = calloc(100, sizeof(char));
		strcpy(name, TEMPDIR);
		strcat(name, "/M2-Mesoplanet-XXXXXX");
		i = mkstemp(name);
		tempfile = fdopen(i, "w");
		if(NULL != tempfile)
		{
			/* Our preprocessed crap */
			output_tokens(global_token, tempfile);
			fclose(tempfile);

			if(!explicit_output_file && OBJECT_FILES_ONLY)
			{
				destination_name = calloc(MAX_STRING, sizeof(char));

				char* directory_separator = strrchr(first_input_filename, '/');
				if(directory_separator == NULL)
				{
					/* No dir separator we just want the entire string */
					directory_separator = first_input_filename;
				}
				else
				{
					directory_separator += 1;
				}

				strcpy(destination_name, directory_separator);

				char* extension = strrchr(destination_name, '.');
				if(extension == NULL)
				{
					extension = destination_name + strlen(destination_name);
				}
				strcpy(extension, ".o\0");
			}

			int no_c_files = global_token == NULL;

			/* Make me a real binary */
			spawn_processes(debug_flag, TEMPDIR, name, destination_name, envp, no_c_files);

			/* And clean up the donkey */
			if(!DIRTY_MODE) remove(name);
		}
		else
		{
			fputs("unable to get a tempfile for M2-Mesoplanet output\n", stderr);
			exit(EXIT_FAILURE);
		}
	}
	return EXIT_SUCCESS;
}
