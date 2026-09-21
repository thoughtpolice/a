%{
/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stdio.h>
#include <stdlib.h>
static unsigned words, total, other;
%}
%x COMMENT
%%
"/*"               { BEGIN COMMENT; }
<COMMENT>"*/"      { BEGIN INITIAL; }
<COMMENT>.         ;
<COMMENT>\n        ;
[a-zA-Z]+          { words++; }
[0-9]+             { total += atoi(yytext); }
[ \t\n]+           ;
.                  { other++; }
%%
int main(void)
{
    yylex();
    printf("%u %u %u\n", words, total, other);
    return 0;
}
