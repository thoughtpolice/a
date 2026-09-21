/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include "api.h"
int main(int argc, char **argv)
{
    yyscan_t scanner;
    YY_BUFFER_STATE buffer;
    FILE *tables;
    int result;
    if (argc != 2 || !(tables = fopen(argv[1], "rb"))) return 1;
    if (yylex_init(&scanner)) return 2;
    if (yytables_fload(tables, scanner)) return 3;
    fclose(tables);
    buffer = yy_scan_string("alpha 42\nother 17", scanner);
    result = yylex(scanner) != 100 || yylex(scanner) != 42 ||
             yylex(scanner) != 100 || yylex(scanner) != 17 || yylex(scanner);
    yy_delete_buffer(buffer, scanner);
    yytables_destroy(scanner);
    yylex_destroy(scanner);
    return result;
}
