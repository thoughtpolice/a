-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

-- The console as a cart sees it: short names over the SDK, and a fixed
-- sixteen colour palette, so a cart reads the way a fantasy console's does.
-- Loaded before the cart, into the same globals.

local api = console

-- The palette a cart indexes by number. Entries are red, green, blue.
local palette = {
    [0] = { 0, 0, 0 },
    [1] = { 29, 43, 83 },
    [2] = { 126, 37, 83 },
    [3] = { 0, 135, 81 },
    [4] = { 171, 82, 54 },
    [5] = { 95, 87, 79 },
    [6] = { 194, 195, 199 },
    [7] = { 255, 241, 232 },
    [8] = { 255, 0, 77 },
    [9] = { 255, 163, 0 },
    [10] = { 255, 236, 39 },
    [11] = { 0, 228, 54 },
    [12] = { 41, 173, 255 },
    [13] = { 131, 118, 156 },
    [14] = { 255, 119, 168 },
    [15] = { 255, 204, 170 },
}

local function rgb(index: number): (number, number, number)
    local entry = palette[index % 16]
    return entry[1], entry[2], entry[3]
end

-- Drawing. Coordinates are frame pixels, and colours are palette indices.
function cls(color: number?)
    local r, g, b = rgb(color or 0)
    api.gfx_clear(r, g, b, 255)
end

function rectfill(x: number, y: number, w: number, h: number, color: number)
    local r, g, b = rgb(color)
    api.gfx_fill_rect(x, y, w, h, r, g, b, 255)
end

function rect(x: number, y: number, w: number, h: number, color: number)
    local r, g, b = rgb(color)
    api.gfx_draw_rect(x, y, w, h, r, g, b, 255)
end

function line(x0: number, y0: number, x1: number, y1: number, color: number)
    local r, g, b = rgb(color)
    api.gfx_draw_line(x0, y0, x1, y1, r, g, b, 255)
end

function circfill(cx: number, cy: number, radius: number, color: number)
    local r, g, b = rgb(color)
    api.gfx_fill_circle(cx, cy, radius, r, g, b, 255)
end

-- The built-in font draws capitals; lowercase is folded for you.
function text(message: string, x: number, y: number, color: number)
    local r, g, b = rgb(color)
    api.gfx_draw_text(x, y, message, r, g, b, 255)
end

function camera(dx: number?, dy: number?)
    api.gfx_set_camera(dx or 0, dy or 0)
end

-- Drawing outside the clip rectangle is dropped; `clip()` with nothing takes
-- it off again.
function clip(x: number?, y: number?, w: number?, h: number?)
    if x == nil then
        api.gfx_set_clip()
    else
        api.gfx_set_clip(x, y or 0, w or SCREEN_WIDTH, h or SCREEN_HEIGHT)
    end
end

-- Sprites. A sheet is an image the platform keeps: a cart writes one out as
-- rows of characters, one per pixel, where a hex digit is a palette index and
-- any other character -- a dot reads best -- leaves the pixel clear. Give a
-- tile size and the sheet is also a tileset, its tiles numbered from zero,
-- left to right and top to bottom.
local index_of: { [string]: number } = {}
for at = 0, 15 do
    local digit = string.sub("0123456789abcdef", at + 1, at + 1)
    index_of[digit] = at
    index_of[string.upper(digit)] = at
end

local Sheet = {}
Sheet.__index = Sheet

local function flip_bits(flip_x: boolean?, flip_y: boolean?): number
    local bits = 0
    if flip_x then
        bits += api.flip.HORIZONTAL
    end
    if flip_y then
        bits += api.flip.VERTICAL
    end
    return bits
end

-- Draws a rectangle of the sheet with its top left corner at x, y.
function Sheet.blit(self, sx: number, sy: number, sw: number, sh: number, x: number, y: number,
                    flip_x: boolean?, flip_y: boolean?)
    api.gfx_draw_sprite(self.handle, sx, sy, sw, sh, x, y, flip_bits(flip_x, flip_y))
end

-- Draws one tile, by its number.
function Sheet.spr(self, tile: number, x: number, y: number, flip_x: boolean?, flip_y: boolean?)
    local w, h = self.tile_width, self.tile_height
    api.gfx_draw_sprite(self.handle, (tile % self.columns) * w, math.floor(tile / self.columns) * h,
        w, h, x, y, flip_bits(flip_x, flip_y))
end

-- Draws a tilemap written the way a sheet is: a hex digit per tile, and
-- anything else for a place with no tile in it.
function Sheet.map(self, rows: { string }, x: number, y: number)
    for row, line in rows do
        for column = 1, #line do
            local tile = index_of[string.sub(line, column, column)]
            if tile then
                self:spr(tile, x + (column - 1) * self.tile_width, y + (row - 1) * self.tile_height)
            end
        end
    end
end

-- A sheet is also allowed to arrive as a list of tiles rather than as rows,
-- which is how the art for one reads best: each tile is written out on its
-- own and they are laid side by side here.
local function strip(tiles: { { string } }): { string }
    local rows = {}
    for line = 1, #tiles[1] do
        local row = ""
        for _, tile in tiles do
            row ..= tile[line]
        end
        rows[line] = row
    end
    return rows
end

function sheet(art: { any }, tile_width: number?, tile_height: number?)
    local rows: { string } = if type(art[1]) == "table" then strip(art :: any) else art :: any
    local height = #rows
    local width = #rows[1]
    local pixels = buffer.create(width * height * 4)
    for row, line in rows do
        for column = 1, width do
            local at = index_of[string.sub(line, column, column)]
            if at then
                local r, g, b = rgb(at)
                local offset = ((row - 1) * width + column - 1) * 4
                buffer.writeu8(pixels, offset, r)
                buffer.writeu8(pixels, offset + 1, g)
                buffer.writeu8(pixels, offset + 2, b)
                buffer.writeu8(pixels, offset + 3, 255)
            end
        end
    end
    local tile_w = tile_width or width
    return setmetatable({
        handle = api.gfx_sheet(width, height, buffer.tostring(pixels)),
        width = width,
        height = height,
        tile_width = tile_w,
        tile_height = tile_height or height,
        columns = math.max(1, math.floor(width / tile_w)),
    }, Sheet)
end

-- Input. `btn()` with no argument returns the whole mask.
local held = 0
local pressed = 0

function btn(button: number?): boolean | number
    if button == nil then
        return held
    end
    return bit32.band(held, button) ~= 0
end

-- The buttons that went down this frame and were not down in the one before,
-- for the things that should happen once however long a button is held.
function btnp(button: number?): boolean | number
    if button == nil then
        return pressed
    end
    return bit32.band(pressed, button) ~= 0
end

function mouse(): (number, number, number)
    return api.input_mouse()
end

-- Time.
function frame(): number
    return api.clock_frame()
end

function time(): number
    return api.clock_now_ms() / 1000
end

-- The button names a cart compares against.
BUTTON = api.button

-- Called by the runtime before each frame, so `btn` reads one consistent
-- snapshot for the whole frame rather than re-polling per call.
function __console_begin_frame()
    local now = api.input_poll()
    pressed = bit32.band(now, bit32.bnot(held))
    held = now
end

-- The display a cart draws on.
local width, height = api.gfx_info()
SCREEN_WIDTH = width
SCREEN_HEIGHT = height

-- Randomness comes from the console rather than the clock, so a cart is as
-- repeatable as the host it runs on: a headless run derives its seed from the
-- one it was given and replays the same game every time.
math.randomseed(api.system_random_seed())
