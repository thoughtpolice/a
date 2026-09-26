// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Exercises what each runtime supplies to a static program: unwinding
// through libunwind and libc++abi's personality, thread_local destructors,
// futex waits, LLVM libc's float parsing inside libc++, the filesystem and
// format libraries, and compiler-rt's 128-bit, half, bfloat16 and x87
// conversions and CPU detection. It reads nothing from the machine but its
// working directory, since it runs as a build action.

#include <atomic>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <format>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

#include <time.h>

namespace {

std::atomic<int> destroyed;

struct Counted {
  ~Counted() { destroyed.fetch_add(1); }
};

thread_local Counted counted;

[[gnu::noinline]] void deep(int depth) {
  std::string frame(32, 'x');
  if (depth == 0)
    throw std::out_of_range("deep");
  deep(depth - 1);
}

std::chrono::nanoseconds thread_cpu_time() {
  timespec now;
  clock_gettime(CLOCK_THREAD_CPUTIME_ID, &now);
  return std::chrono::seconds(now.tv_sec) + std::chrono::nanoseconds(now.tv_nsec);
}

} // namespace

int main() {
  try {
    deep(8);
    return 1;
  } catch (const std::out_of_range &e) {
    if (std::string(e.what()) != "deep")
      return 2;
  }

  std::thread([] { (void)&counted; }).join();
  if (destroyed.load() != 1)
    return 3;

  // libc++ polls an atomic for a few microseconds before it waits on a
  // futex. The waker stores long after the waiter announces itself, so the
  // waiter sleeps in the kernel, and a futex wait that failed to block would
  // leave it spinning on the processor instead.
  std::atomic<int> flag{0};
  std::atomic<bool> waiting{false};
  std::thread waker([&] {
    while (!waiting.load())
      std::this_thread::yield();
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    flag.store(1);
    flag.notify_one();
  });
  auto before = thread_cpu_time();
  waiting.store(true);
  flag.wait(0);
  auto spent = thread_cpu_time() - before;
  waker.join();
  if (spent > std::chrono::milliseconds(20))
    return 4;

  double parsed = 0;
  const std::string text = "1.5e300";
  auto result = std::from_chars(text.data(), text.data() + text.size(), parsed);
  if (result.ec != std::errc() || parsed != 1.5e300)
    return 5;

  volatile unsigned __int128 big = static_cast<unsigned __int128>(1) << 100;
  unsigned __int128 third = big / 3;
  volatile long double extended = static_cast<long double>(third);
  if (static_cast<unsigned __int128>(extended) >> 90 != 341)
    return 6;

  volatile float single = 1.5f;
  volatile _Float16 half = single;
  volatile __bf16 brain = single;
  if (static_cast<float>(half) != 1.5f || static_cast<float>(brain) != 1.5f)
    return 7;

  __builtin_cpu_init();
  if (!__builtin_cpu_supports("sse2"))
    return 8;

  std::filesystem::path path = std::filesystem::path("a/b/../c").lexically_normal();
  if (!std::filesystem::exists(std::filesystem::current_path()))
    return 9;

  std::cout << std::format("runtimes {} {:x} {}\n", path.string(),
                           static_cast<std::uint64_t>(third >> 64), parsed);
}
