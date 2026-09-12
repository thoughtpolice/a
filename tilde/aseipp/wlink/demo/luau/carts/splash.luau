-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

-- What the console shows when it was started without a cart.

local function centre(message: string, y: number, color: number)
    text(message, SCREEN_WIDTH / 2 - #message * 3, y, color)
end

function _draw()
    cls(1)
    rect(24, 92, SCREEN_WIDTH - 48, 72, 5)
    centre("LUAU CONSOLE", 112, 7)
    centre("NO CART LOADED", 128, 6)
    centre("RUN: LUAU CART.LUAU", 144, 13)
end
