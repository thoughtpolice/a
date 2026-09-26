/* SPDX-FileCopyrightText: 2026 Austin Seipp */
/* SPDX-License-Identifier: Apache-2.0 */
%option reentrant noyywrap nodefault
%%
[0-9]+                return atoi(yytext);
[a-z]+                return 100;
[ \n]+                ;
.                     return -1;
%%
