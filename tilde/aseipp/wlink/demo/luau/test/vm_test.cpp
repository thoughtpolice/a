// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The interpreter running a compiled cart as a guest: the same bytecode the
// build produces, on the console's own allocator, through wasm32.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "lua.h"
#include "lualib.h"
#include "runtime.h"
#include "smoke_bytecode.h"

namespace {

void require(bool condition, const char* what) {
  if (!condition) {
    printf("FAIL luau %s\n", what);
    exit(1);
  }
}

const double kExpected = 6765;  // fib(20), which the cart checks its own way to.

}  // namespace

void console_guest_init(void) {
  lua_State* L = luaL_newstate();
  require(L != nullptr, "new state");
  luaL_openlibs(L);
  printf("PASS luau %s\n", "state");

  int loaded = luau_load(L, "=smoke", reinterpret_cast<const char*>(kSmokeBytecode),
                         sizeof(kSmokeBytecode), 0);
  if (loaded != 0) {
    printf("FAIL luau load: %s\n", lua_tostring(L, -1));
    exit(1);
  }
  printf("PASS luau %s\n", "load");

  int called = lua_pcall(L, 0, 1, 0);
  if (called != 0) {
    printf("FAIL luau call: %s\n", lua_tostring(L, -1));
    exit(1);
  }
  require(lua_isnumber(L, -1), "cart returned a number");
  require(lua_tonumber(L, -1) == kExpected, "cart returned the expected value");
  lua_pop(L, 1);
  printf("PASS luau %s\n", "run");

  // Bytecode the interpreter will not accept has to come back as a message
  // rather than a trap. A Luau *runtime* error is a separate matter: raising
  // one unwinds, which wasm32 has no instruction for, so carts must not fail
  // yet. See the README.
  const char* failing = "\0";
  int bad = luau_load(L, "=bad", failing, 1, 0);
  require(bad != 0, "invalid bytecode is refused");
  lua_pop(L, 1);
  printf("PASS luau %s\n", "errors");

  // The collector has to survive real churn: the cart above allocates, and
  // a full collection must leave the state usable.
  lua_gc(L, LUA_GCCOLLECT, 0);
  int before = lua_gc(L, LUA_GCCOUNT, 0);
  lua_newtable(L);
  for (int i = 1; i <= 2000; ++i) {
    lua_pushinteger(L, i);
    lua_rawseti(L, -2, i);
  }
  lua_pop(L, 1);
  lua_gc(L, LUA_GCCOLLECT, 0);
  int after = lua_gc(L, LUA_GCCOUNT, 0);
  require(after <= before + 64, "collector reclaims a discarded table");
  printf("PASS luau %s\n", "gc");

  lua_close(L);
  printf("PASS luau %s\n", "all");
  exit(0);
}

int32_t console_guest_frame(uint32_t dt_ms) {
  (void)dt_ms;
  return 0;
}
