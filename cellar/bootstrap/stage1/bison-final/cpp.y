/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
%language "c++"
%define api.value.type {long}
%parse-param {const char*& input} {long& answer}
%lex-param {const char*& input}
%code {
#include <cstdlib>
#include <cctype>
static int yylex(yy::parser::semantic_type *value, const char*& input);
}
%token NUMBER
%left '+' '-'
%left '*'
%%
start: expression { answer = $1; };
expression: NUMBER { $$ = $1; }
    | expression '+' expression { $$ = $1 + $3; }
    | expression '-' expression { $$ = $1 - $3; }
    | expression '*' expression { $$ = $1 * $3; }
    | '(' expression ')' { $$ = $2; };
%%
static int yylex(yy::parser::semantic_type *value, const char*& input)
{
    while (std::isspace(static_cast<unsigned char>(*input))) ++input;
    if (std::isdigit(static_cast<unsigned char>(*input))) {
        char *end;
        *value = std::strtol(input, &end, 10);
        input = end;
        return yy::parser::token::NUMBER;
    }
    return *input ? *input++ : 0;
}
void yy::parser::error(const std::string&) {}
int main(int argc, char **argv)
{
    if (argc != 3) return 1;
    const char *input = argv[1];
    long answer = 0;
    yy::parser parser(input, answer);
    if (parser.parse()) return 2;
    return answer != std::strtol(argv[2], 0, 10);
}
