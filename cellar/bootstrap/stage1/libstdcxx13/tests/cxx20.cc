/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 *
 * C++20 library facilities, including the time zone database embedded in
 * the static library.
 */
#include <algorithm>
#include <barrier>
#include <bit>
#include <chrono>
#include <compare>
#include <format>
#include <latch>
#include <numbers>
#include <ranges>
#include <semaphore>
#include <span>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

using namespace std::chrono;

int main()
{
    std::vector<int> values{5, 3, 8, 1};
    std::ranges::sort(values);
    auto even = values | std::views::filter([](int v) { return v % 2 == 0; });
    if (std::ranges::distance(even) != 1 || *even.begin() != 8) return 1;

    std::span<const int> view(values);
    if (view.size() != 4 || view.back() != 8) return 2;

    if (std::format("{:>6}|{:x}|{:.2f}", "ab", 255, std::numbers::pi) != "    ab|ff|3.14") return 3;

    if (std::popcount(0xf0u) != 4 || std::bit_width(1024u) != 11) return 4;
    if ((std::string("alpha") <=> std::string("beta")) >= 0) return 5;
    if (!std::string("bootstrap").starts_with("boot")) return 6;

    const time_zone *london = locate_zone("Europe/London");
    sys_days summer = 2024y / July / 1;
    sys_days winter = 2024y / January / 1;
    if (london->get_info(summer).offset != 1h || london->get_info(winter).offset != 0h) return 7;
    if (get_tzdb().version.empty()) return 8;

    year_month_day date{2024y / February / last};
    if (date.day() != 29d) return 9;
    std::ostringstream text;
    text << date;
    if (text.str() != "2024-02-29") return 10;

    std::latch ready(2);
    std::barrier sync(2);
    std::counting_semaphore<2> slots(0);
    int total = 0;
    std::jthread worker([&](std::stop_token stop) {
        ready.count_down();
        sync.arrive_and_wait();
        total += 1;
        slots.release();
        while (!stop.stop_requested()) std::this_thread::yield();
    });
    ready.count_down();
    ready.wait();
    sync.arrive_and_wait();
    slots.acquire();
    worker.request_stop();
    worker.join();
    return total == 1 ? 0 : 11;
}
