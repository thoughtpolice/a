/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>
extern "C" long add_many(int, ...);
struct Base { virtual ~Base() {} };
struct Derived : Base { int value; Derived() : value(42) {} };
int main()
{
    std::vector<long> values = {3, 1, 2};
    std::sort(values.begin(), values.end());
    long result = 0;
    std::thread worker([&] { result = add_many(2, 4294967296L, values[2]); });
    worker.join();
    Derived value; Base& base = value;
    if (dynamic_cast<Derived&>(base).value != 42 || result != 4294967299L) return 1;
    try { throw std::runtime_error("native C++ 4294967299"); }
    catch (const std::exception& e) { std::cout << e.what() << '\n'; }
}
