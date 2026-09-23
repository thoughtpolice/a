/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <algorithm>
#include <cassert>
#include <deque>
#include <list>
#include <map>
#include <numeric>
#include <set>
#include <sstream>
#include <string>
#include <valarray>
#include <vector>
#include <ext/pb_ds/assoc_container.hpp>
#include <ext/pb_ds/tree_policy.hpp>

int main()
{
    std::vector<int> v;
    for (int i = 100; i; --i) v.push_back(i);
    std::sort(v.begin(), v.end());
    assert(std::accumulate(v.begin(), v.end(), 0) == 5050);
    std::deque<int> d(v.begin(), v.end());
    d.push_front(0); d.push_back(101);
    assert(d.front() == 0 && d.back() == 101);
    std::list<int> l(v.begin(), v.end());
    l.reverse(); l.sort(); l.unique();
    assert(l.size() == 100 && l.front() == 1 && l.back() == 100);
    std::map<std::string, int> m;
    m["first"] = 17; m["second"] = 25;
    assert(m["first"] + m["second"] == 42);
    std::set<int> s(v.begin(), v.end());
    assert(s.count(42) && !s.count(101));
    std::string text("abc"); text += std::string(1000, 'x');
    std::string copy(text); copy.replace(3, 1000, "def");
    assert(copy == "abcdef" && text.size() == 1003);
    std::ostringstream out; out << 42 << ':' << copy;
    assert(out.str() == "42:abcdef");
    std::valarray<double> a(2.0, 10), b(3.0, 10);
    a = a * b + b;
    assert(a.sum() == 90.0);
    typedef __gnu_pbds::tree<int, __gnu_pbds::null_type, std::less<int>,
        __gnu_pbds::rb_tree_tag, __gnu_pbds::tree_order_statistics_node_update> tree;
    tree t;
    for (int i = 0; i < 100; ++i) t.insert(i * 2);
    assert(*t.find_by_order(21) == 42 && t.order_of_key(42) == 21);
}
