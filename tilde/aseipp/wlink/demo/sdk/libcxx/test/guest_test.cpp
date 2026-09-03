// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The containers as a guest sees them, on the console's own allocator, next
// to the freestanding headers the compiler supplies.

#include <stdio.h>
#include <stdlib.h>

#include <algorithm>
#include <optional>
#include <string>
#include <string_view>
#include <tuple>
#include <unordered_set>
#include <utility>
#include <vector>

#include "runtime.h"

namespace {

void require(bool condition, const char* what) {
  if (!condition) {
    printf("FAIL libcxx %s\n", what);
    exit(1);
  }
}

// Counts its own lifetime events, so the containers can be held to destroying
// exactly what they construct.
struct Tracked {
  static int live;
  int value;

  explicit Tracked(int v = 0) : value(v) { ++live; }
  Tracked(const Tracked& other) : value(other.value) { ++live; }
  Tracked(Tracked&& other) noexcept : value(other.value) { ++live; }
  Tracked& operator=(const Tracked& other) { value = other.value; return *this; }
  Tracked& operator=(Tracked&& other) noexcept { value = other.value; return *this; }
  ~Tracked() { --live; }
};

int Tracked::live = 0;

void test_vector() {
  std::vector<int> numbers;
  require(numbers.empty() && numbers.size() == 0, "vector starts empty");
  for (int i = 0; i < 100; ++i) numbers.push_back(i);
  require(numbers.size() == 100 && numbers[99] == 99 && numbers.back() == 99, "vector push_back");
  require(numbers.capacity() >= 100, "vector capacity");

  numbers.erase(numbers.begin() + 10, numbers.begin() + 20);
  require(numbers.size() == 90 && numbers[10] == 20, "vector erase range");
  numbers.insert(numbers.begin() + 10, 7);
  require(numbers.size() == 91 && numbers[10] == 7 && numbers[11] == 20, "vector insert");

  std::vector<int> copied = numbers;
  require(copied == numbers, "vector copy compares equal");
  std::vector<int> moved = std::move(copied);
  require(moved == numbers && copied.empty(), "vector move leaves source empty");

  numbers.resize(5);
  require(numbers.size() == 5 && numbers[4] == 4, "vector shrink");
  numbers.resize(8, 42);
  require(numbers.size() == 8 && numbers[7] == 42, "vector grow with fill");

  std::vector<int> listed{3, 1, 2};
  std::sort(listed.begin(), listed.end());
  require(listed[0] == 1 && listed[2] == 3, "vector sorts through <algorithm>");

  {
    std::vector<Tracked> tracked;
    for (int i = 0; i < 40; ++i) tracked.emplace_back(i);
    require(Tracked::live == 40, "vector constructs each element once");
    tracked.erase(tracked.begin());
    require(Tracked::live == 39 && tracked[0].value == 1, "vector erase destroys one");
    std::vector<Tracked> taken = std::move(tracked);
    require(Tracked::live == 39, "vector move does not copy");
  }
  require(Tracked::live == 0, "vector destroys every element");
  printf("PASS libcxx %s\n", "vector");
}

void test_string() {
  std::string text;
  require(text.empty() && text.c_str()[0] == '\0', "empty string is terminated");
  text = "hello";
  require(text.size() == 5 && text == "hello", "string assignment");
  text += ", world";
  require(text == "hello, world" && text.size() == 12, "string append");
  require(text.substr(7) == "world" && text.substr(0, 5) == "hello", "string substr");
  require(text.find('w') == 7 && text.find("lo,") == 3 && text.find('z') == std::string::npos,
          "string find");
  require(text.rfind('l') == 10, "string rfind");

  std::string other = text;
  require(other == text, "string copy");
  std::string moved = std::move(other);
  require(moved == text && other.empty(), "string move leaves source empty");

  require(std::string("abc") < std::string("abd"), "string ordering");
  require(std::string("abc") + "d" == "abcd", "string concatenation");

  std::string built;
  for (int i = 0; i < 500; ++i) built.push_back('x');
  require(built.size() == 500 && built[499] == 'x' && built.c_str()[500] == '\0',
          "string grows and stays terminated");

  std::string_view view = text;
  require(view.size() == 12 && view.substr(0, 5) == "hello", "string converts to string_view");
  require(std::string(view) == text, "string_view converts back");
  printf("PASS libcxx %s\n", "string");
}

void test_unordered_set() {
  std::unordered_set<std::string> names{"index", "newindex", "call"};
  require(names.size() == 3, "set takes an initializer list");
  require(names.count("call") == 1 && names.count("concat") == 0, "set lookup");
  require(names.insert("concat").second, "set insert reports a new key");
  require(!names.insert("concat").second, "set insert rejects a duplicate");
  require(names.size() == 4 && names.count("concat") == 1, "set grew");
  require(names.erase("concat") == 1 && names.count("concat") == 0, "set erase");
  require(names.erase("concat") == 0, "set erase of a missing key");

  // Enough keys to force several rehashes, with every one still findable.
  std::unordered_set<std::string> many;
  for (int i = 0; i < 300; ++i) {
    char key[16];
    snprintf(key, sizeof(key), "key%d", i);
    many.insert(key);
  }
  require(many.size() == 300, "set holds every key");
  for (int i = 0; i < 300; ++i) {
    char key[16];
    snprintf(key, sizeof(key), "key%d", i);
    require(many.count(key) == 1, "set finds a key after rehashing");
  }
  size_t walked = 0;
  for (const std::string& key : many) {
    require(!key.empty(), "set iteration yields keys");
    ++walked;
  }
  require(walked == 300, "set iteration covers every key");
  printf("PASS libcxx %s\n", "unordered_set");
}

void test_interop() {
  std::vector<std::string> words{"gamma", "alpha", "beta"};
  std::sort(words.begin(), words.end());
  require(words[0] == "alpha" && words[2] == "gamma", "sorting strings in a vector");

  std::optional<std::string> maybe;
  require(!maybe.has_value(), "optional starts empty");
  maybe = std::string("value");
  require(maybe.has_value() && *maybe == "value", "optional holds a string");

  std::vector<std::pair<int, std::string>> pairs;
  pairs.emplace_back(1, "one");
  pairs.emplace_back(2, "two");
  require(pairs.size() == 2 && pairs[1].second == "two", "vector of pairs");

  auto parts = std::make_tuple(1, std::string("two"), 3.0);
  int first = 0;
  std::string second;
  double third = 0;
  std::tie(first, second, third) = parts;
  require(first == 1 && second == "two" && third == 3.0, "tuple with a string");

  std::vector<std::vector<int>> nested(3);
  nested[1].push_back(5);
  require(nested.size() == 3 && nested[1][0] == 5 && nested[2].empty(), "nested vectors");
  printf("PASS libcxx %s\n", "interop");
}

}  // namespace

void console_guest_init(void) {
  test_vector();
  test_string();
  test_unordered_set();
  test_interop();
  printf("PASS libcxx %s\n", "all");
  exit(0);
}

int32_t console_guest_frame(uint32_t dt_ms) {
  (void)dt_ms;
  return 0;
}
