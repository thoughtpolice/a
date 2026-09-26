/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
%{
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
static const char *input;
static long answer;
int yylex(void);
void yyerror(const char *message);
%}
%union { long number; }
%token <number> NUMBER
%type <number> expression
%left '+' '-'
%left '*'
%%
start: expression { answer = $1; };
expression: NUMBER { $$ = $1; }
    | expression '+' expression { $$ = $1 + $3; }
    | expression '-' expression { $$ = $1 - $3; }
    | expression '*' expression { $$ = $1 * $3; }
    | '(' expression ')' { $$ = $2; }
    ;
%%
int yylex(void)
{
    char *end;
    while (isspace((unsigned char)*input)) input++;
    if (isdigit((unsigned char)*input)) {
        yylval.number = strtol(input, &end, 10);
        input = end;
        return NUMBER;
    }
    return *input ? *input++ : 0;
}
void yyerror(const char *message) { fprintf(stderr, "%s\n", message); }
int main(int argc, char **argv)
{
    if (argc != 3) return 1;
    input = argv[1];
    if (yyparse()) return 2;
    return answer != strtol(argv[2], 0, 10);
}
