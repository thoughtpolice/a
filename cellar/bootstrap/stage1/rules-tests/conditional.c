/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */
static int calls;
static int side(int value) { calls = calls + 1; return value; }
static int mask(int value, int wide) { return value & (wide ? 63 : 31); }
static int add(int a, int b, int c) { return a + b + c; }
int main(void)
{
    int i;
    for (i = 0; i < 80; i = i + 1) {
        if (mask(i, 0) != (i & 31)) return 1;
        if (mask(i, 1) != (i & 63)) return 2;
        if (100 + (i ? 7 : 9) != (i ? 107 : 109)) return 3;
        if (add(2, 10 + (i ? 3 : 4), 5) != (i ? 20 : 21)) return 4;
        if (5 * (i ? (i & 1 ? 2 : 3) : 4) != (i ? (i & 1 ? 10 : 15) : 20)) return 5;
        calls = 0;
        if (8 + (side(i) ? side(11) : side(13)) != (i ? 19 : 21)) return 6;
        if (calls != 2) return 7;
    }
    return 0;
}
