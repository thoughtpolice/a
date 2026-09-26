/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
%debug
%union { char *string; }
%token <string> WORD
%destructor { free($$); ++destroyed; } <string>
%printer { fprintf(yyo, "%s", $$); ++printed; } <string>
%code {
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static int destroyed, printed, emitted, correct;
int yylex(void);
void yyerror(const char *message);
}
%%
start: WORD '!' { free($1); };
%%
int yylex(void)
{
    if (emitted++ == 0) {
        yylval.string = strdup("owned-token");
        if (!yylval.string) exit(3);
        return WORD;
    }
    if (emitted == 2) return correct ? '!' : '?';
    return 0;
}
void yyerror(const char *message) { (void)message; }
int main(int argc, char **argv)
{
    int status;
    if (argc != 2) return 1;
    correct = strcmp(argv[1], "valid") == 0;
    yydebug = 1;
    status = yyparse();
    return !printed || status != !correct || destroyed != !correct;
}
