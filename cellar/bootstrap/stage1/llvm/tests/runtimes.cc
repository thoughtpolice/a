// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Exercises what each runtime supplies to a static program: unwinding
// through libunwind and libc++abi's personality, thread_local destructors,
// futex waits, LLVM libc's float parsing inside libc++, the filesystem and
// format libraries, and compiler-rt's 128-bit, half, bfloat16 and x87
// conversions and CPU detection.

#include <atomic>
#include <charconv>
#include <cstdint>
#include <filesystem>
#include <format>
#include <iostream>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>

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

  std::atomic<int> flag{0};
  std::thread waker([&] {
    flag.store(1);
    flag.notify_one();
  });
  flag.wait(0);
  waker.join();

  double parsed = 0;
  const std::string text = "1.5e300";
  auto result = std::from_chars(text.data(), text.data() + text.size(), parsed);
  if (result.ec != std::errc() || parsed != 1.5e300)
    return 4;

  volatile unsigned __int128 big = static_cast<unsigned __int128>(1) << 100;
  unsigned __int128 third = big / 3;
  volatile long double extended = static_cast<long double>(third);
  if (static_cast<unsigned __int128>(extended) >> 90 != 341)
    return 5;

  volatile float single = 1.5f;
  volatile _Float16 half = single;
  volatile __bf16 brain = single;
  if (static_cast<float>(half) != 1.5f || static_cast<float>(brain) != 1.5f)
    return 6;

  __builtin_cpu_init();
  if (!__builtin_cpu_supports("sse2"))
    return 7;

  std::random_device device;
  (void)device();

  std::filesystem::path path = std::filesystem::path("a/b/../c").lexically_normal();
  if (!std::filesystem::exists(std::filesystem::current_path()))
    return 8;

  std::cout << std::format("runtimes {} {:x} {}\n", path.string(),
                           static_cast<std::uint64_t>(third >> 64), parsed);
}
