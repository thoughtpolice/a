// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The SDK as the interpreter sees it. Every entry here calls the bindings
// wit-bindgen generates from console:sdk, so the names and the argument order
// are the WIT's; the friendlier spelling a cart uses is built on top of this
// in Lua, by the prelude.

#include <stdint.h>
#include <string.h>

#include "console_api.h"
#include "game.h"
#include "lua.h"
#include "lualib.h"

namespace {

console_sdk_gfx_color_t color_from(lua_State* L, int at) {
    console_sdk_gfx_color_t color;
    color.r = static_cast<uint8_t>(luaL_checkinteger(L, at));
    color.g = static_cast<uint8_t>(luaL_checkinteger(L, at + 1));
    color.b = static_cast<uint8_t>(luaL_checkinteger(L, at + 2));
    color.a = static_cast<uint8_t>(luaL_optinteger(L, at + 3, 255));
    return color;
}

console_sdk_gfx_rect_t rect_from(lua_State* L, int at) {
    console_sdk_gfx_rect_t rect;
    rect.x = luaL_checkinteger(L, at);
    rect.y = luaL_checkinteger(L, at + 1);
    rect.w = static_cast<uint32_t>(luaL_checkinteger(L, at + 2));
    rect.h = static_cast<uint32_t>(luaL_checkinteger(L, at + 3));
    return rect;
}

int gfx_clear(lua_State* L) {
    console_sdk_gfx_color_t color = color_from(L, 1);
    console_sdk_gfx_clear(&color);
    return 0;
}

int gfx_fill_rect(lua_State* L) {
    console_sdk_gfx_rect_t rect = rect_from(L, 1);
    console_sdk_gfx_color_t color = color_from(L, 5);
    console_sdk_gfx_fill_rect(&rect, &color);
    return 0;
}

int gfx_draw_rect(lua_State* L) {
    console_sdk_gfx_rect_t rect = rect_from(L, 1);
    console_sdk_gfx_color_t color = color_from(L, 5);
    console_sdk_gfx_draw_rect(&rect, &color);
    return 0;
}

int gfx_draw_line(lua_State* L) {
    int32_t x0 = luaL_checkinteger(L, 1);
    int32_t y0 = luaL_checkinteger(L, 2);
    int32_t x1 = luaL_checkinteger(L, 3);
    int32_t y1 = luaL_checkinteger(L, 4);
    console_sdk_gfx_color_t color = color_from(L, 5);
    console_sdk_gfx_draw_line(x0, y0, x1, y1, &color);
    return 0;
}

int gfx_fill_circle(lua_State* L) {
    int32_t cx = luaL_checkinteger(L, 1);
    int32_t cy = luaL_checkinteger(L, 2);
    uint32_t radius = static_cast<uint32_t>(luaL_checkinteger(L, 3));
    console_sdk_gfx_color_t color = color_from(L, 4);
    console_sdk_gfx_fill_circle(cx, cy, radius, &color);
    return 0;
}

int gfx_draw_text(lua_State* L) {
    int32_t x = luaL_checkinteger(L, 1);
    int32_t y = luaL_checkinteger(L, 2);
    size_t length = 0;
    const char* text = luaL_checklstring(L, 3, &length);
    console_sdk_gfx_color_t color = color_from(L, 4);
    // The binding takes a borrowed range and does not free it.
    game_string_t borrowed;
    borrowed.ptr = const_cast<uint8_t*>(reinterpret_cast<const uint8_t*>(text));
    borrowed.len = length;
    console_sdk_gfx_draw_text(x, y, &borrowed, &color);
    return 0;
}

int gfx_info(lua_State* L) {
    console_sdk_gfx_display_info_t info;
    console_sdk_gfx_info(&info);
    lua_pushinteger(L, static_cast<int>(info.width));
    lua_pushinteger(L, static_cast<int>(info.height));
    lua_pushinteger(L, static_cast<int>(info.refresh_hz));
    return 3;
}

int gfx_set_mode(lua_State* L) {
    uint32_t width = static_cast<uint32_t>(luaL_checkinteger(L, 1));
    uint32_t height = static_cast<uint32_t>(luaL_checkinteger(L, 2));
    lua_pushboolean(L, console_sdk_gfx_set_mode(width, height));
    return 1;
}

int gfx_set_camera(lua_State* L) {
    console_sdk_gfx_set_camera(luaL_checkinteger(L, 1), luaL_checkinteger(L, 2));
    return 0;
}

int gfx_set_clip(lua_State* L) {
    if (lua_isnoneornil(L, 1)) {
        console_sdk_gfx_set_clip(nullptr);
        return 0;
    }
    console_sdk_gfx_rect_t rect = rect_from(L, 1);
    console_sdk_gfx_set_clip(&rect);
    return 0;
}

// A sheet's pixels live in the platform, so a cart builds one once and then
// names it by handle. The handle is tagged userdata: the tag is what tells a
// sheet from any other userdata a cart might hold, and the destructor the tag
// carries drops the platform's copy when the collector takes the handle.
const int kSheetTag = 1;

struct Sheet {
    console_sdk_gfx_own_sheet_t handle;
};

void sheet_drop(lua_State*, void* memory) {
    console_sdk_gfx_sheet_drop_own(static_cast<Sheet*>(memory)->handle);
}

int gfx_sheet(lua_State* L) {
    uint32_t width = static_cast<uint32_t>(luaL_checkinteger(L, 1));
    uint32_t height = static_cast<uint32_t>(luaL_checkinteger(L, 2));
    size_t length = 0;
    const char* rgba = luaL_checklstring(L, 3, &length);
    size_t expected = static_cast<size_t>(width) * height * 4;
    if (length != expected)
        luaL_error(L, "a %d by %d sheet takes %d bytes, not %d", static_cast<int>(width),
                   static_cast<int>(height), static_cast<int>(expected), static_cast<int>(length));

    // The constructor copies what it is given and does not take the range.
    game_list_u8_t borrowed;
    borrowed.ptr = const_cast<uint8_t*>(reinterpret_cast<const uint8_t*>(rgba));
    borrowed.len = length;
    Sheet* sheet = static_cast<Sheet*>(lua_newuserdatatagged(L, sizeof(Sheet), kSheetTag));
    sheet->handle = console_sdk_gfx_constructor_sheet(width, height, &borrowed);
    return 1;
}

int gfx_draw_sprite(lua_State* L) {
    Sheet* sheet = static_cast<Sheet*>(lua_touserdatatagged(L, 1, kSheetTag));
    if (!sheet) luaL_typeerror(L, 1, "sheet");
    console_sdk_gfx_rect_t source = rect_from(L, 2);
    int32_t x = luaL_checkinteger(L, 6);
    int32_t y = luaL_checkinteger(L, 7);
    console_sdk_gfx_flip_t flip = static_cast<console_sdk_gfx_flip_t>(luaL_optinteger(L, 8, 0));
    console_sdk_gfx_draw_sprite(console_sdk_gfx_borrow_sheet(sheet->handle), &source, x, y, flip);
    return 0;
}

int input_poll(lua_State* L) {
    lua_pushinteger(L, static_cast<int>(console_sdk_input_poll()));
    return 1;
}

int input_mouse(lua_State* L) {
    console_sdk_input_mouse_state_t state;
    console_sdk_input_mouse(&state);
    lua_pushinteger(L, state.x);
    lua_pushinteger(L, state.y);
    lua_pushinteger(L, static_cast<int>(state.buttons));
    return 3;
}

int clock_now_ms(lua_State* L) {
    lua_pushnumber(L, static_cast<double>(console_sdk_clock_now_ms()));
    return 1;
}

int clock_frame(lua_State* L) {
    lua_pushnumber(L, static_cast<double>(console_sdk_clock_frame()));
    return 1;
}

int clock_set_frame_rate(lua_State* L) {
    uint32_t hz = static_cast<uint32_t>(luaL_checkinteger(L, 1));
    lua_pushinteger(L, static_cast<int>(console_sdk_clock_set_frame_rate(hz)));
    return 1;
}

int system_random_seed(lua_State* L) {
    // Lua numbers carry 53 bits exactly, so the seed is cut to that.
    lua_pushnumber(L, static_cast<double>(console_sdk_system_random_seed() >> 11));
    return 1;
}

const luaL_Reg kConsoleApi[] = {
    {"gfx_clear", gfx_clear},
    {"gfx_fill_rect", gfx_fill_rect},
    {"gfx_draw_rect", gfx_draw_rect},
    {"gfx_draw_line", gfx_draw_line},
    {"gfx_fill_circle", gfx_fill_circle},
    {"gfx_draw_text", gfx_draw_text},
    {"gfx_info", gfx_info},
    {"gfx_set_mode", gfx_set_mode},
    {"gfx_set_camera", gfx_set_camera},
    {"gfx_set_clip", gfx_set_clip},
    {"gfx_sheet", gfx_sheet},
    {"gfx_draw_sprite", gfx_draw_sprite},
    {"input_poll", input_poll},
    {"input_mouse", input_mouse},
    {"clock_now_ms", clock_now_ms},
    {"clock_frame", clock_frame},
    {"clock_set_frame_rate", clock_set_frame_rate},
    {"system_random_seed", system_random_seed},
    {nullptr, nullptr},
};

}  // namespace

void console_api_open(lua_State* L) {
    lua_setuserdatadtor(L, kSheetTag, sheet_drop);

    lua_newtable(L);
    for (const luaL_Reg* entry = kConsoleApi; entry->name; ++entry) {
        lua_pushcfunction(L, entry->func, entry->name);
        lua_setfield(L, -2, entry->name);
    }
    // The button bits, named as console:sdk/input.buttons spells them.
    static const struct {
        const char* name;
        int bit;
    } kButtons[] = {
        {"UP", CONSOLE_SDK_INPUT_BUTTONS_UP},
        {"DOWN", CONSOLE_SDK_INPUT_BUTTONS_DOWN},
        {"LEFT", CONSOLE_SDK_INPUT_BUTTONS_LEFT},
        {"RIGHT", CONSOLE_SDK_INPUT_BUTTONS_RIGHT},
        {"A", CONSOLE_SDK_INPUT_BUTTONS_A},
        {"B", CONSOLE_SDK_INPUT_BUTTONS_B},
        {"START", CONSOLE_SDK_INPUT_BUTTONS_START},
        {"SELECT", CONSOLE_SDK_INPUT_BUTTONS_SELECT},
    };
    lua_newtable(L);
    for (const auto& button : kButtons) {
        lua_pushinteger(L, button.bit);
        lua_setfield(L, -2, button.name);
    }
    lua_setfield(L, -2, "button");

    // The ways a sprite can be turned over, as console:sdk/gfx.flip has them.
    lua_newtable(L);
    lua_pushinteger(L, CONSOLE_SDK_GFX_FLIP_HORIZONTAL);
    lua_setfield(L, -2, "HORIZONTAL");
    lua_pushinteger(L, CONSOLE_SDK_GFX_FLIP_VERTICAL);
    lua_setfield(L, -2, "VERTICAL");
    lua_setfield(L, -2, "flip");
    lua_setglobal(L, "console");
}
