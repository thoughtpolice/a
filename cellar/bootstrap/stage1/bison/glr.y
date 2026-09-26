/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
%glr-parser
%expect-rr 2
%code {
#include <stdlib.h>
static const char *input;
static int answer;
int yylex(void);
void yyerror(const char *message);
}
%%
start: 'a' x 'd' { answer = 1; }
     | 'b' x 'e' { answer = 2; }
     | 'a' y 'e' { answer = 3; }
     | 'b' y 'd' { answer = 4; };
x: 'c';
y: 'c';
%%
int yylex(void) { return *input ? *input++ : 0; }
void yyerror(const char *message) { (void)message; }
int main(int argc, char **argv)
{
    if (argc != 3) return 1;
    input = argv[1];
    if (yyparse()) return 2;
    return answer != atoi(argv[2]);
}
