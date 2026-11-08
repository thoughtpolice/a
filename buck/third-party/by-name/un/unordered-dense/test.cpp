// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Insert, look up and erase through the map, and check that its values stay
// densely stored in insertion order.

#include <ankerl/unordered_dense.h>
#include <cstdio>
#include <string>

int main() {
    ankerl::unordered_dense::map<std::string, int> m;
    for (int i = 0; i < 1000; i++) m[std::to_string(i)] = i;
    if (m.size() != 1000 || m.at("737") != 737) return std::puts("lookup failed"), 1;
    m.erase("0");
    if (m.contains("0") || m.size() != 999) return std::puts("erase failed"), 1;

    ankerl::unordered_dense::set<int> s;
    for (int i = 0; i < 10; i++) s.insert(i);
    int expect = 0;
    for (int v : s.values())
        if (v != expect++) return std::puts("values not in insertion order"), 1;
    return 0;
}
