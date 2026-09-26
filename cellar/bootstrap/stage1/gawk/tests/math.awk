# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
BEGIN {
    printf "%.0f %.2f %.0f\n", 4294967296+17, sqrt(2.25), 2^10
    if (sin(0) != 0 || cos(0) != 1 || log(1) != 0 || exp(0) != 1) exit 1
    print and(255, 15), or(16, 3), xor(7, 3), lshift(1, 12), rshift(4096, 12)
    srand(17); x = rand(); y = rand(); srand(17)
    if (x != rand() || y != rand() || x < 0 || x >= 1 || y < 0 || y >= 1) exit 2
    print strftime("%Y-%m-%d %H:%M:%S", 946684800)
}
