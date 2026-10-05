// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Fuzzes the framelog decoder with arbitrary bytes. The proofs say that
// what the encoder writes decodes back; this checks the other direction,
// that a log which decodes at all is exactly the encoding of its records
// (Framelog.canonical), and that scanning never claims more than it read.

#include <lean/lean.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>

extern "C" {
void lean_initialize_runtime_module();
lean_object* initialize_framelog_Framelog(uint8_t builtin);
uint8_t framelog_canonical(lean_object* log);
uint64_t framelog_intact_bytes(lean_object* log);

int LLVMFuzzerInitialize(int*, char***) {
  lean_initialize_runtime_module();
  lean_object* res = initialize_framelog_Framelog(1);
  if (!lean_io_result_is_ok(res)) {
    lean_io_result_show_error(res);
    std::abort();
  }
  lean_dec_ref(res);
  lean_io_mark_end_initialization();
  return 0;
}

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  lean_object* log = lean_alloc_sarray(1, size, size);
  std::memcpy(lean_sarray_cptr(log), data, size);
  lean_inc(log);
  if (!framelog_canonical(log)) {
    std::abort();
  }
  if (framelog_intact_bytes(log) > size) {
    std::abort();
  }
  return 0;
}
}
