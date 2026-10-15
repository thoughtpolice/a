// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A C++ program calling Lean code from :greeting, with a name it chose and
// with bytes no caller should send.

#include <lean/lean.h>

#include <cstdio>
#include <cstring>
#include <string>

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

  // Lean strings are UTF-8, and invalid UTF-8 becomes U+FFFD on the way in,
  // so whatever bytes arrive, the greeting is still a greeting.
  const std::string awkward[] = {
      std::string(),
      std::string("\0embedded\0nul", 14),
      std::string("\xff\xfe not utf-8 \xc3"),
      std::string("\xf0\x9f\x91\x8b"),
      std::string(4096, 'x'),
  };
  for (const std::string& name : awkward) {
    lean_object* greeting = depot_lean_greeting(lean_mk_string_from_bytes(name.data(), name.size()));
    if (std::strncmp(lean_string_cstr(greeting), "hello, ", 7) != 0) {
      std::printf("not a greeting for %zu bytes: %s\n", name.size(), lean_string_cstr(greeting));
      ok = 0;
    }
    lean_dec_ref(greeting);
  }
  return ok ? 0 : 1;
}
