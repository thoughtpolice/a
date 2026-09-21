/* SPDX-FileCopyrightText: 2026 Austin Seipp */
/* SPDX-License-Identifier: Apache-2.0 */
%option nodefault
%%
[a-z]+                printf("word:%s\n", yytext);
[0-9]+                printf("number:%s\n", yytext);
[ \n]+                ;
.                     return 1;
%%
