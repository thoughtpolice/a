/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
%define api.value.type {long}
%code {
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
static const char *input;
static long answer;
int yylex(void);
void yyerror(const char *message);
}
%token NUMBER PLUS MINUS STAR LPAREN RPAREN
%%
start: sum { answer = $1; };
sum: product { $$ = $1; }
    | sum PLUS product { $$ = $1 + $3; }
    | sum MINUS product { $$ = $1 - $3; }
    ;
product: atom { $$ = $1; }
    | product STAR atom { $$ = $1 * $3; }
    ;
atom: NUMBER { $$ = $1; }
    | LPAREN sum RPAREN { $$ = $2; }
    ;
%%
int yylex(void)
{
    char *end;
    while (isspace((unsigned char)*input)) input++;
    if (isdigit((unsigned char)*input)) {
        yylval = strtol(input, &end, 10);
        input = end;
        return NUMBER;
    }
    switch (*input ? *input++ : 0) {
    case '+': return PLUS;
    case '-': return MINUS;
    case '*': return STAR;
    case '(': return LPAREN;
    case ')': return RPAREN;
    case 0: return 0;
    default: return '?';
    }
}
void yyerror(const char *message) { fprintf(stderr, "%s\n", message); }
int main(int argc, char **argv)
{
    if (argc != 3) return 1;
    input = argv[1];
    if (yyparse()) return 2;
    return answer != strtol(argv[2], 0, 10);
}
