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

struct object_file_list* extra_object_files;

struct include_path_list* include_paths;

/* What we are currently working on */
struct token_list* global_token;

/* Make our string collection more efficient */
char* hold_string;
int string_index;

int MAX_STRING;

/* enable preprocessor-only mode */
int PREPROCESSOR_MODE;

/* enable spawn behavior to be effective */
char* M2LIBC_PATH;
char* Architecture;
char* OperatingSystem;
int WORDSIZE;
int ENDIAN;
char* BASEADDRESS;
int STDIO_USED;
char* TEMPDIR;
int OBJECT_FILES_ONLY;

/* So we don't shoot ourself in the face */
int FUZZING;
int DIRTY_MODE;
int DEBUG_LEVEL;
