/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
int main(void)
{
    int i, sum = 0;
    for (i = 0; i < 10; ++i) {
        if (i & 1) sum += 2;
        else sum += 3;
    }
    return sum != 25;
}
