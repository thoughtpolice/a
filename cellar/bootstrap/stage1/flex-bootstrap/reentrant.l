/* SPDX-FileCopyrightText: 2026 Austin Seipp */
/* SPDX-License-Identifier: Apache-2.0 */
%option 8bit reentrant noyywrap nodefault yylineno
%{
struct counters { int words, sum; };
#define YY_EXTRA_TYPE struct counters *
%}
%%
"@"                   unput('x');
[a-zA-Z]+             { ++yyextra->words; return 1; }
[0-9]+                { yyextra->sum += atoi(yytext); return 2; }
[ \t\n]+              ;
.                     return 3;
%%
int main(void)
{
    yyscan_t left, right;
    struct counters a = {0, 0}, b = {0, 0};
    YY_BUFFER_STATE ab, bb;
    if (yylex_init(&left) || yylex_init(&right)) return 1;
    yyset_extra(&a, left); yyset_extra(&b, right);
    ab = yy_scan_string("alpha 17\nbeta 25\n", left);
    bb = yy_scan_bytes("other 9 @ ignored", 9, right);
    yyset_lineno(1, left); yyset_lineno(1, right);
    if (yylex(left) != 1 || yylex(right) != 1 || yylex(left) != 2) return 2;
    while (yylex(left));
    while (yylex(right));
    if (a.words != 2 || a.sum != 42 || b.words != 2 || b.sum != 9) return 3;
    if (yyget_lineno(left) != 3 || yyget_lineno(right) != 1) return 4;
    yy_delete_buffer(ab, left); yy_delete_buffer(bb, right);
    yylex_destroy(left); yylex_destroy(right);
    return 0;
}
