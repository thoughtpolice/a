// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A C++ program calling Lean code from :greeting.

#include <lean/lean.h>

#include <cstdio>
#include <cstring>

extern "C" {
// lean.h leaves this one to the embedding program, as the Lean manual's FFI
// chapter does. A program importing `Lean` itself calls lean_initialize().
void lean_initialize_runtime_module();
// Module initializers are named after the package (:greeting's target name)
// and the module.
lean_object* initialize_greeting_Greeting(uint8_t builtin);
lean_object* depot_lean_greeting(lean_object* name);
}

int main() {
  lean_initialize_runtime_module();
  lean_object* res = initialize_greeting_Greeting(1);
  if (!lean_io_result_is_ok(res)) {
    lean_io_result_show_error(res);
    lean_dec_ref(res);
    return 1;
  }
  lean_dec_ref(res);
  lean_io_mark_end_initialization();

  lean_object* out = depot_lean_greeting(lean_mk_string("c++"));
  const char* text = lean_string_cstr(out);
  std::printf("%s\n", text);
  int ok = std::strcmp(text, "hello, c++ (42)") == 0;
  lean_dec_ref(out);
  return ok ? 0 : 1;
}
