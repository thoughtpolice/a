/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
%option c++ noyywrap nodefault
%{
#include <sstream>
%}
%%
[0-9]+ { return 42; }
[a-z]+ { return 100; }
[ \n]+ ;
. { return -1; }
%%
int main()
{
    std::istringstream input("alpha 123\nbeta 42");
    std::ostringstream output;
    yyFlexLexer scanner(&input, &output);
    return scanner.yylex() != 100 || scanner.yylex() != 42 ||
           scanner.yylex() != 100 || scanner.yylex() != 42 || scanner.yylex();
}
