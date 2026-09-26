/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <cassert>
#include <cstdio>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <locale>
#include <sstream>
#include <string>

struct Punctuation : std::numpunct<char> {
    char do_decimal_point() const { return ','; }
    char do_thousands_sep() const { return '_'; }
    std::string do_grouping() const { return "\3"; }
};
int main()
{
    std::locale classic("C");
    assert(std::use_facet<std::ctype<char> >(classic).toupper('a') == 'A');
    std::locale custom(classic, new Punctuation);
    std::ostringstream formatted;
    formatted.imbue(custom);
    formatted << std::fixed << std::setprecision(2) << 12345.25;
    assert(formatted.str() == "12_345,25");
    std::istringstream parsed(formatted.str()); parsed.imbue(custom);
    double number = 0; parsed >> number; assert(number == 12345.25);
    std::wstringstream wide;
    wide << L"wide " << 42;
    assert(wide.str() == L"wide 42");
    {
        std::ofstream file("data", std::ios::binary);
        file.exceptions(std::ios::failbit | std::ios::badbit);
        file << "contents";
        file.seekp(3LL * 1024 * 1024 * 1024); file.put('z');
        assert(file.tellp() == 3LL * 1024 * 1024 * 1024 + 1);
    }
    {
        std::ifstream file("data", std::ios::binary);
        // Seek without reading the sparse gap into memory.
        file.seekg(-1, std::ios::end); assert(file.get() == 'z');
        file.seekg(0); char prefix[8]; file.read(prefix, 8);
        assert(std::string(prefix, 8) == "contents");
    }
    assert(!std::remove("data"));
    std::cout << "stream output\n";
    std::cerr << "stream error\n";
    std::ofstream marker("passed"); marker << "passed\n";
}
