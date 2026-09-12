// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The console as a machine that runs one cart. It starts an interpreter,
// installs the SDK and the prelude, runs the cart once to let it define
// itself, and then drives `_init`, `_update`, and `_draw` the way a fantasy
// console does.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "Luau/Common.h"
#include "cart_bytecode.h"
#include "console.h"
#include "console_api.h"
#include "lua.h"
#include "lualib.h"
#include "prelude_bytecode.h"
#include "runtime.h"

namespace {

// The console's own display: a cart draws on this regardless of how large
// the window or terminal showing it happens to be. It is the resolution the
// art is drawn at, not a window size, so raising it means carts with more
// detail in them rather than the same picture made bigger.
const int kScreenWidth = 256;
const int kScreenHeight = 256;

lua_State* g_state;
bool g_running;
bool g_has_update;
bool g_has_draw;

// Every export of a module with C++ constructors is wrapped by the linker so
// that __wasm_call_ctors runs before it, and nothing in the component model
// tells the linker this module is a reactor whose constructors run once. That
// covers more than init and frame: the host calls the guest's cabi_realloc to
// hand back the bytes of a file read, so the constructors run again part way
// through a read.
//
// Luau registers its fast flags from those constructors by pushing each onto
// a list, and pushing the same objects onto a list they are already in links
// it into a cycle, after which the lookups never finish. This runs before
// Luau's own constructors on every pass, so each pass rebuilds the lists from
// nothing, which is the state they expect. A C guest never notices any of
// this because it has no constructors for the linker to wrap.
struct ReleaseFlagRegistrations {
    ReleaseFlagRegistrations() {
        Luau::FValue<bool>::list = nullptr;
        Luau::FValue<int>::list = nullptr;
    }
};

__attribute__((init_priority(101))) ReleaseFlagRegistrations g_release_flag_registrations;

[[noreturn]] void fail(const char* what, const char* detail) {
    printf("cart: %s: %s\n", what, detail ? detail : "?");
    exit(1);
}

// An error raised where nothing is protecting it, which a cart can only
// reach by erroring inside a handler. Nothing can be done about it, but the
// interpreter offers the message on its way down and it is worth printing.
void report(lua_State* L, int) {
    const char* message = lua_tostring(L, -1);
    printf("cart: %s\n", message ? message : "error");
    exit(1);
}

// Called with the error a protected call failed with, while the stack it
// happened on is still standing, so the trace names the frames that led to
// it rather than the ones left after unwinding.
int describe(lua_State* L) {
    const char* message = lua_tostring(L, -1);
    // Level one starts the trace at the frame that raised the error rather
    // than at this handler.
    luaL_traceback(L, L, message ? message : "error", 1);
    return 1;
}

// Runs a call under a handler that turns the error into a message and a
// trace, and leaves the error on the stack for the caller to report.
int protected_call(lua_State* L, int arguments, int results = 0) {
    // The handler goes below the function and its arguments, and comes off
    // again whatever happens.
    lua_pushcfunction(L, describe, "describe");
    lua_insert(L, -2 - arguments);
    int handler = lua_gettop(L) - 1 - arguments;
    int status = lua_pcall(L, arguments, results, handler);
    lua_remove(L, handler);
    return status;
}

// The path a host mounts a cart at, so the console can be pointed at one
// without being rebuilt around it. Without this the built-in cart runs.
const char kCartPath[] = "cart.luauc";

unsigned char* read_mounted_cart(size_t* size) {
    // The SDK's stdio sits on the same file resources and already handles
    // short reads, so a cart is read the way any other file would be.
    FILE* file = fopen(kCartPath, "rb");
    if (!file) return nullptr;
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return nullptr;
    }
    long total = ftell(file);
    rewind(file);
    if (total <= 0) {
        fclose(file);
        return nullptr;
    }
    unsigned char* cart = static_cast<unsigned char*>(malloc(static_cast<size_t>(total)));
    if (!cart) {
        fclose(file);
        return nullptr;
    }
    size_t read = fread(cart, 1, static_cast<size_t>(total), file);
    fclose(file);
    if (read != static_cast<size_t>(total)) {
        free(cart);
        return nullptr;
    }
    *size = read;
    return cart;
}

void run_chunk(lua_State* L, const char* name, const unsigned char* bytecode, size_t size) {
    if (luau_load(L, name, reinterpret_cast<const char*>(bytecode), size, 0) != 0)
        fail(name, lua_tostring(L, -1));
    if (protected_call(L, 0) != 0) fail(name, lua_tostring(L, -1));
}

// Calls a global the cart may not have defined, leaving the stack as it was.
// A cart that fails here has already been reported; it is stopped rather than
// called again, because a cart that threw once will usually throw every frame
// and bury the first message under the rest.
bool call_global(lua_State* L, const char* name, int arguments) {
    lua_getglobal(L, name);
    if (!lua_isfunction(L, -1)) {
        lua_pop(L, 1 + arguments);
        return false;
    }
    if (arguments == 1) lua_insert(L, -2);
    if (protected_call(L, arguments) != 0) {
        printf("cart: %s: %s\n", name, lua_tostring(L, -1));
        lua_pop(L, 1);
        g_running = false;
    }
    return true;
}

bool has_global_function(lua_State* L, const char* name) {
    lua_getglobal(L, name);
    bool found = lua_isfunction(L, -1);
    lua_pop(L, 1);
    return found;
}

}  // namespace

void console_guest_init(void) {
    lua_State* L = luaL_newstate();
    if (!L) fail("start", "out of memory");
    lua_callbacks(L)->panic = report;
    luaL_openlibs(L);
    console_api_open(L);

    lua_getglobal(L, "console");
    lua_getfield(L, -1, "gfx_set_mode");
    lua_pushinteger(L, kScreenWidth);
    lua_pushinteger(L, kScreenHeight);
    if (protected_call(L, 2, 1) != 0) fail("display", lua_tostring(L, -1));
    lua_pop(L, 2);

    run_chunk(L, "=prelude", kPreludeBytecode, sizeof(kPreludeBytecode));
    size_t mounted_size = 0;
    unsigned char* mounted = read_mounted_cart(&mounted_size);
    if (mounted) {
        run_chunk(L, "=cart", mounted, mounted_size);
        free(mounted);
    } else {
        run_chunk(L, "=cart", kCartBytecode, sizeof(kCartBytecode));
    }

    g_state = L;
    g_running = true;
    g_has_update = has_global_function(L, "_update");
    g_has_draw = has_global_function(L, "_draw");

    call_global(L, "_init", 0);
}

int32_t console_guest_frame(uint32_t dt_ms) {
    lua_State* L = g_state;
    if (!L || !g_running) return 0;

    // One input snapshot per frame, so every btn() in this frame agrees.
    call_global(L, "__console_begin_frame", 0);

    if (g_has_update) {
        lua_pushnumber(L, static_cast<double>(dt_ms) / 1000.0);
        call_global(L, "_update", 1);
    }
    if (g_has_draw) call_global(L, "_draw", 0);

    // A cart ends the run by clearing this, which the runtime reads back
    // after every frame.
    lua_getglobal(L, "__console_quit");
    if (lua_toboolean(L, -1)) g_running = false;
    lua_pop(L, 1);

    return g_running ? 1 : 0;
}
