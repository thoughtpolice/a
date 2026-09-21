/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include <stdio.h>
#include <stdlib.h>
#include "M2libc/bootstrappable.h"

int main(int argc, char **argv)
{
    require(argc == 3, "capture-probe: missing arguments\n");
    char *value = getenv("CAPTURE_TEST");
    if(value) fputs(value, stdout);
    fputc(':', stdout);
    fputs(argv[2], stdout);
    fputc('\n', stdout);
    return strtoint(argv[1]);
}
