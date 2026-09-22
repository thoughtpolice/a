/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#ifndef _REENTRANT
#error -pthread must select the native preprocessor specification
#endif
#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <exception>
#include <future>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>
#include <unistd.h>

static std::atomic<int> constructions(0), total(0);
static std::once_flag once;
static int once_count;
struct Singleton { Singleton() { ++constructions; } int get() { return 42; } };
static Singleton& singleton() { static Singleton s; return s; }
int main()
{
    alarm(15);
    std::mutex mutex;
    std::condition_variable ready;
    bool go = false;
    std::vector<std::thread> threads;
    for (int i = 0; i < 4; ++i) threads.emplace_back([&] {
        { std::unique_lock<std::mutex> lock(mutex); ready.wait(lock, [&] { return go; }); }
        std::call_once(once, [] { ++once_count; });
        assert(singleton().get() == 42);
        for (int j = 0; j < 10000; ++j) ++total;
        try { throw std::runtime_error("thread"); }
        catch (...) {
            std::exception_ptr p = std::current_exception();
            try { std::rethrow_exception(p); }
            catch (const std::runtime_error& e) { assert(e.what()[0] == 't'); }
        }
    });
    { std::lock_guard<std::mutex> lock(mutex); go = true; }
    ready.notify_all();
    for (auto& t : threads) t.join();
    assert(total == 40000 && once_count == 1 && constructions == 1);
    std::future<int> result = std::async(std::launch::async, [] { return 42; });
    assert(result.get() == 42);
    std::future<int> failed = std::async(std::launch::async, []() -> int { throw std::logic_error("async"); });
    try { failed.get(); assert(false); } catch (const std::logic_error&) {}
    std::promise<int> promise;
    std::future<int> future = promise.get_future();
    assert(future.wait_for(std::chrono::milliseconds(1)) == std::future_status::timeout);
    promise.set_value(7); assert(future.get() == 7);
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    assert(std::chrono::steady_clock::now().time_since_epoch().count() > 0);
}
