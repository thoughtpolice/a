// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A fozzie harness driving Lean code from :greeting with arbitrary bytes.
// Under the fuzz transition the generated C is instrumented too, so the
// engine sees coverage inside the Lean functions.

#include <lean/lean.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>

extern "C" {
void lean_initialize_runtime_module();
lean_object* initialize_greeting_Greeting(uint8_t builtin);
lean_object* depot_lean_greeting(lean_object* name);

int LLVMFuzzerInitialize(int*, char***) {
  lean_initialize_runtime_module();
  lean_object* res = initialize_greeting_Greeting(1);
  if (!lean_io_result_is_ok(res)) {
    lean_io_result_show_error(res);
    std::abort();
  }
  lean_dec_ref(res);
  lean_io_mark_end_initialization();
  return 0;
}

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  // Invalid UTF-8 becomes U+FFFD, so any input is a valid Lean string.
  lean_object* name = lean_mk_string_from_bytes(reinterpret_cast<const char*>(data), size);
  lean_object* out = depot_lean_greeting(name);
  if (std::strncmp(lean_string_cstr(out), "hello, ", 7) != 0) {
    std::abort();
  }
  lean_dec_ref(out);
  return 0;
}
}
