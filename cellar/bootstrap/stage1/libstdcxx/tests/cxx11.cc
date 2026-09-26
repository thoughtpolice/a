/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <array>
#include <cassert>
#include <cmath>
#include <complex>
#include <functional>
#include <limits>
#include <memory>
#include <random>
#include <ratio>
#include <string>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <vector>

int main()
{
    std::array<int, 3> a = {{1, 2, 3}};
    assert(a.at(2) == 3);
    std::unordered_map<std::string, int> map = {{"a", 17}, {"b", 25}};
    assert(map["a"] + map["b"] == 42);
    std::unordered_set<long double> set = {1.25L, 2.5L, 1.25L};
    assert(set.size() == 2);
    std::unique_ptr<int> unique(new int(7));
    std::shared_ptr<int> shared(std::move(unique));
    std::weak_ptr<int> weak(shared);
    assert(!unique && *weak.lock() == 7);
    shared.reset(); assert(weak.expired());
    std::tuple<int, std::string> tuple(42, "tuple");
    assert(std::get<0>(tuple) == 42 && std::get<1>(tuple) == "tuple");
    std::function<int(int)> twice = [](int n) { return n * 2; };
    assert(std::bind(twice, std::placeholders::_1)(21) == 42);
    std::mt19937 random(5489u);
    assert(random() == 3499211612u);
    std::complex<double> c(3, 4);
    assert(std::abs(c) == 5 && std::norm(c) == 25);
    assert(std::numeric_limits<long double>::digits == 64);
    assert(std::isnan(std::numeric_limits<double>::quiet_NaN()));
    assert(std::to_string(42) == "42" && std::stoi("17") == 17);
    std::vector<std::unique_ptr<int> > values;
    values.emplace_back(new int(42));
    assert(*values.front() == 42);
}
