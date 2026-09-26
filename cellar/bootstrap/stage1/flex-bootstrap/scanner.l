/* SPDX-FileCopyrightText: 2026 Austin Seipp */
/* SPDX-License-Identifier: Apache-2.0 */
%option 8bit noyywrap nodefault
%x COMMENT
%{
static int words, sum, other;
%}
%%
"/*"                  BEGIN(COMMENT);
<COMMENT>"*/"         BEGIN(INITIAL);
<COMMENT>(.|\n)       ;
[a-zA-Z]+             ++words;
[0-9]+                sum += atoi(yytext);
[ \t\n]+              ;
.                     ++other;
%%
int main(void)
{
    YY_BUFFER_STATE input = yy_scan_string("alpha123 /* ignored999 */ beta42\ngamma7 ?\303\251\n");
    yylex();
    yy_delete_buffer(input);
    return words != 3 || sum != 172 || other != 3;
}
