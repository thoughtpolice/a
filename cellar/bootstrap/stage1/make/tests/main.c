/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <stdio.h>
int helper(void);
int main(void) { printf("native make %d\n", helper()); return helper() != 42; }
