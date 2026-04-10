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

#include <stdlib.h>
#include <stdio.h>
#include <string.h>


#define FALSE 0
#define TRUE 1


extern int in_set(int c, char* s);
extern int match(char* a, char* b);
extern void require(int flag, char* error);
extern char* int2str(int x, int base, int signed_p);
extern void reset_hold_string(void);
extern int starts_with(char* str, char* needle);
extern int ends_with(char* str, char* needle);

struct type
{
	struct type* next;
	int size;
	int offset;
	int is_signed;
	struct type* indirect;
	struct type* members;
	struct type* type;
	char* name;
};

struct token_list
{
	struct token_list* next;
	union
	{
		struct token_list* locals;
		struct token_list* prev;
	};
	char* s;
	union
	{
		struct type* type;
		char* filename;
	};
	union
	{
		struct token_list* arguments;
		struct token_list* expansion;
		int depth;
		int linenumber;
	};
};

struct object_file_list
{
	char* file;
	struct object_file_list* next;
};

struct include_path_list
{
	char* path;
	struct include_path_list* next;
};

#include "cc_globals.h"
