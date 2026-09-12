// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_LUAU_API_H
#define CONSOLE_LUAU_API_H

struct lua_State;

// Installs the `console` global: the SDK's own names, which the prelude
// dresses up into the shorter ones a cart calls.
void console_api_open(lua_State* L);

#endif
