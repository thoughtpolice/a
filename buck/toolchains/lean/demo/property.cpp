// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Checks the framelog decoder on logs near a valid one. The proofs say that
// what the encoder writes decodes back; this checks the other direction on
// every truncation and every single-byte change of the log in argv[1]: a log
// which decodes at all is exactly the encoding of its records
// (Framelog.canonical), and scanning never claims more than it read.

#include <lean/lean.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <vector>

extern "C" {
void lean_initialize_runtime_module();
lean_object* initialize_framelog_Framelog(uint8_t builtin);
uint8_t framelog_canonical(lean_object* log);
uint64_t framelog_intact_bytes(lean_object* log);
}

namespace {

lean_object* byte_array(const std::vector<uint8_t>& bytes) {
  lean_object* array = lean_alloc_sarray(1, bytes.size(), bytes.size());
  if (!bytes.empty()) {
    std::memcpy(lean_sarray_cptr(array), bytes.data(), bytes.size());
  }
  return array;
}

// Whether `bytes` keeps both properties. The exports take ownership of their
// argument, so the array is shared between the two calls.
bool holds(const std::vector<uint8_t>& bytes) {
  lean_object* log = byte_array(bytes);
  lean_inc(log);
  bool canonical = framelog_canonical(log);
  bool bounded = framelog_intact_bytes(log) <= bytes.size();
  return canonical && bounded;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: %s LOG\n", argv[0]);
    return 2;
  }
  std::ifstream file(argv[1], std::ios::binary);
  const std::vector<uint8_t> seed(std::istreambuf_iterator<char>(file), {});
  if (seed.empty()) {
    std::fprintf(stderr, "%s: empty or unreadable\n", argv[1]);
    return 2;
  }

  lean_initialize_runtime_module();
  lean_object* res = initialize_framelog_Framelog(1);
  if (!lean_io_result_is_ok(res)) {
    lean_io_result_show_error(res);
    lean_dec_ref(res);
    return 1;
  }
  lean_dec_ref(res);
  lean_io_mark_end_initialization();

  // The valid log itself, intact from end to end.
  lean_object* whole = byte_array(seed);
  if (framelog_intact_bytes(whole) != seed.size()) {
    std::fprintf(stderr, "the seed log is not intact\n");
    return 1;
  }

  std::vector<std::vector<uint8_t>> cases;
  for (size_t length = 0; length < seed.size(); length++) {
    cases.emplace_back(seed.begin(), seed.begin() + length);
  }
  for (size_t at = 0; at < seed.size(); at++) {
    for (uint8_t value : {uint8_t(0x00), uint8_t(0xff), uint8_t(seed[at] ^ 0x01), uint8_t(seed[at] ^ 0x80)}) {
      if (value != seed[at]) {
        cases.push_back(seed);
        cases.back()[at] = value;
      }
    }
  }

  int failures = 0;
  for (const std::vector<uint8_t>& bytes : cases) {
    if (!holds(bytes)) {
      std::fprintf(stderr, "a %zu-byte log breaks a property:", bytes.size());
      for (uint8_t byte : bytes) {
        std::fprintf(stderr, " %02x", byte);
      }
      std::fprintf(stderr, "\n");
      failures++;
    }
  }
  std::printf("%zu logs, %d failing\n", cases.size(), failures);
  return failures == 0 ? 0 : 1;
}
