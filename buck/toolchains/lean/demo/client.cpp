// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A C++ program writing and checking a framelog through the Lean library.
// The log itself is a std::string; Lean frames records and scans logs.

#include <lean/lean.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

extern "C" {
void lean_initialize_runtime_module();
lean_object* initialize_framelog_Framelog(uint8_t builtin);

// Exported Lean functions take ownership of their arguments.
lean_object* framelog_frame(lean_object* payload);
uint64_t framelog_intact_frames(lean_object* log);
uint64_t framelog_intact_bytes(lean_object* log);

// Framelog.Crc32.fast, the C function behind the checksum.
uint32_t framelog_crc32(b_lean_obj_arg data);
}

static lean_object* to_lean(const std::string& s) {
  lean_object* a = lean_alloc_sarray(1, s.size(), s.size());
  std::memcpy(lean_sarray_cptr(a), s.data(), s.size());
  return a;
}

static bool check(bool ok, const char* what) {
  std::printf("%s %s\n", ok ? "ok  " : "FAIL", what);
  return ok;
}

// How many whole frames `log` starts with, and their size in bytes.
static void scan(const std::string& log, uint64_t* frames, uint64_t* bytes) {
  lean_object* l = to_lean(log);
  lean_inc(l);
  *frames = framelog_intact_frames(l);
  *bytes = framelog_intact_bytes(l);
}

int main() {
  lean_initialize_runtime_module();
  lean_object* res = initialize_framelog_Framelog(1);
  if (!lean_io_result_is_ok(res)) {
    lean_io_result_show_error(res);
    return 1;
  }
  lean_dec_ref(res);
  lean_io_mark_end_initialization();

  bool ok = true;

  lean_object* digits = to_lean("123456789");
  ok &= check(framelog_crc32(digits) == 0xCBF43926u, "crc32 of 123456789 is 0xCBF43926");
  lean_dec_ref(digits);

  std::string log;
  const char* records[] = {"begin 7", "put account/alice 100", "commit 7"};
  for (const char* r : records) {
    lean_object* f = framelog_frame(to_lean(r));
    log.append(reinterpret_cast<const char*>(lean_sarray_cptr(f)), lean_sarray_size(f));
    lean_dec_ref(f);
  }

  uint64_t frames, bytes;
  scan(log, &frames, &bytes);
  ok &= check(frames == 3 && bytes == log.size(), "a log of three records scans whole");

  // A crash in the middle of the last write.
  scan(log.substr(0, log.size() - 3), &frames, &bytes);
  ok &= check(frames == 2, "a torn final write keeps the two records before it");

  // A flipped bit in the second record.
  std::string damaged = log;
  damaged[12] ^= 0x10;
  scan(damaged, &frames, &bytes);
  ok &= check(frames == 1, "damage in the second record stops the scan after the first");

  return ok ? 0 : 1;
}
