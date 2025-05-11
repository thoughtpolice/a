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

/* What types we have */
struct type* global_types;
struct type* prim_types;

struct include_path_list* include_paths;

/* What we are currently working on */
struct token_list* global_token;

/* Output reorder collections*/
struct token_list* output_list;
struct token_list* strings_list;
struct token_list* globals_list;
struct token_list* global_constant_list;

struct static_variable_list* function_static_variables_list;

/* Make our string collection more efficient */
char* hold_string;
int string_index;

/* Our Target Architecture */
int Architecture;
int register_size;
int stack_direction;

int MAX_STRING;
struct type* integer;
struct type* unsigned_integer;
struct type* signed_char;
struct type* unsigned_char;
struct type* signed_short;
struct type* unsigned_short;
struct type* signed_long;
struct type* unsigned_long;
struct type* signed_long_long;
struct type* unsigned_long_long;
struct type* function_pointer;

/* enable bootstrap-mode */
int BOOTSTRAP_MODE;

int FOLLOW_INCLUDES;

/* enable preprocessor-only mode */
int PREPROCESSOR_MODE;

/* feature unsupported by cc_* */
void maybe_bootstrap_error(char* feature);
