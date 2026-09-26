/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <any>
#include <charconv>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory_resource>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <string>
#include <string_view>
#include <thread>
#include <tuple>
#include <variant>
#include <vector>

namespace fs = std::filesystem;

int main()
{
    std::optional<int> maybe;
    if (maybe || !std::optional<int>(3).has_value()) return 1;

    std::variant<int, std::string> value = std::string("text");
    if (std::get<std::string>(value) != "text") return 2;
    value = 7;
    if (std::visit([](auto &&v) { return sizeof(v) > 0; }, value) != true) return 3;

    std::any boxed = 42;
    if (std::any_cast<int>(boxed) != 42) return 4;

    std::string_view view = "prefix:suffix";
    if (view.substr(view.find(':') + 1) != "suffix") return 5;

    char digits[32];
    auto written = std::to_chars(digits, digits + sizeof digits, 1234567);
    int parsed = 0;
    std::from_chars(digits, written.ptr, parsed);
    if (parsed != 1234567) return 6;

    auto [key, number] = std::pair<std::string, int>("answer", 42);
    if (key != "answer" || number != 42) return 7;

    std::pmr::monotonic_buffer_resource arena;
    std::pmr::vector<int> numbers(&arena);
    for (int i = 0; i < 100; ++i) numbers.push_back(i);
    if (numbers.back() != 99) return 8;

    std::shared_mutex lock;
    int shared = 0;
    std::vector<std::thread> workers;
    for (int i = 0; i < 4; ++i)
        workers.emplace_back([&] { std::unique_lock<std::shared_mutex> guard(lock); ++shared; });
    for (auto &worker : workers) worker.join();
    if (shared != 4) return 9;

    fs::path directory = fs::current_path() / "cxx17-tree";
    fs::remove_all(directory);
    if (!fs::create_directories(directory / "nested")) return 10;
    std::ofstream(directory / "nested" / "file.txt") << "contents";
    if (fs::file_size(directory / "nested" / "file.txt") != 8) return 11;
    int files = 0;
    for (auto &entry : fs::recursive_directory_iterator(directory))
        files += entry.is_regular_file();
    if (files != 1) return 12;
    fs::rename(directory / "nested" / "file.txt", directory / "moved.txt");
    if (!fs::exists(directory / "moved.txt") || fs::exists(directory / "nested" / "file.txt")) return 13;
    if (fs::remove_all(directory) != 3) return 14;
    if (fs::exists(directory)) return 15;
    std::ofstream("passed") << "passed\n";
    return 0;
}
