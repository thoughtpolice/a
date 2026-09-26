/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdio.h>
int answer(void);
int main(void)
{
    if (answer() != 42) return 1;
    puts("MesCC RunInfo, separate compilation and archive link passed");
    return 0;
}
