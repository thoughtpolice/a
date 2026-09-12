-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

-- Tetris. The well is ten cells across and twenty down, drawn from a tileset
-- the cart builds at load time: one twelve by twelve block per piece, outlined
-- and then bevelled, so a stack reads as blocks rather than as flat colour.
--
-- Arrows move and soft drop, Z rotates, X drops the piece the rest of the
-- way, and enter starts the next game.

local COLUMNS = 10
local ROWS = 20
local CELL = 12
local WELL_X = 10
local WELL_Y = 10
local PANEL_X = 148

-- How long a piece takes to fall one row, by level, and how a held direction
-- repeats: a press moves at once, waits, and then walks.
local FALL_BY_LEVEL = 0.55
local FALL_FLOOR = 0.08
local SOFT_DROP = 0.04
local REPEAT_DELAY = 0.16
local REPEAT_RATE = 0.05
local CLEAR_TIME = 0.22

-- A piece's colour, and the two shades that give its block an edge.
local BLOCKS = {
    { fill = 12, light = 6, dark = 1 },
    { fill = 10, light = 7, dark = 9 },
    { fill = 14, light = 15, dark = 2 },
    { fill = 11, light = 7, dark = 3 },
    { fill = 8, light = 14, dark = 2 },
    { fill = 13, light = 6, dark = 5 },
    { fill = 9, light = 10, dark = 4 },
}

-- Each piece in the box it turns inside of, which is what makes a rotation a
-- turn of the box rather than of the cells that happen to be filled.
local SHAPES = {
    { "....", "xxxx", "....", "...." },
    { "xx", "xx" },
    { ".x.", "xxx", "..." },
    { ".xx", "xx.", "..." },
    { "xx.", ".xx", "..." },
    { "x..", "xxx", "..." },
    { "..x", "xxx", "..." },
}

-- What a cleared line is worth, by how many went at once.
local LINE_SCORE = { 40, 100, 300, 1200 }

local hex = "0123456789abcdef"

local function digit(color: number): string
    return string.sub(hex, color + 1, color + 1)
end

-- A block is an outline, a lit top and left inside it, and a shaded bottom
-- and right, which is the whole of why a stack looks like stacked things.
local function block_art(block): { string }
    local f, l, d = digit(block.fill), digit(block.light), digit(block.dark)
    local edge = string.rep(d, CELL)
    local rows = { edge, d .. string.rep(l, CELL - 2) .. d }
    local middle = d .. l .. string.rep(f, CELL - 4) .. d .. d
    for _ = 3, CELL - 2 do
        table.insert(rows, middle)
    end
    table.insert(rows, edge)
    table.insert(rows, edge)
    return rows
end

local function rotate(shape: { string }): { string }
    local size = #shape
    local turned = {}
    for y = 1, size do
        local row = ""
        for x = 1, size do
            row ..= string.sub(shape[size + 1 - x], y, y)
        end
        turned[y] = row
    end
    return turned
end

local function cells_of(shape: { string }): { { number } }
    local cells = {}
    for y, row in shape do
        for x = 1, #row do
            if string.sub(row, x, x) ~= "." then
                table.insert(cells, { x - 1, y - 1 })
            end
        end
    end
    return cells
end

-- Both are built once the console is up, in _init.
local blocks
local pieces: { { size: number, rotations: { { { number } } } } } = {}

local well: { { number } } = {}
local piece = 1
local rotation = 1
local piece_x = 0
local piece_y = 0
local next_piece = 1
local fall = 0.0
local repeat_timer = 0.0
local held_direction = 0
local clearing: { number } = {}
local clear_timer = 0.0
local score = 0
local lines = 0
local level = 0
local over = false

local function fits(which: number, turn: number, at_x: number, at_y: number): boolean
    for _, cell in pieces[which].rotations[turn] do
        local x = at_x + cell[1]
        local y = at_y + cell[2]
        if x < 0 or x >= COLUMNS or y >= ROWS then
            return false
        end
        if y >= 0 and well[y + 1][x + 1] ~= 0 then
            return false
        end
    end
    return true
end

local function spawn()
    piece = next_piece
    next_piece = math.random(#SHAPES)
    rotation = 1
    piece_x = math.floor((COLUMNS - pieces[piece].size) / 2)
    piece_y = 0
    fall = 0
    over = not fits(piece, rotation, piece_x, piece_y)
end

local function start_game()
    well = {}
    for row = 1, ROWS do
        local cells = {}
        for column = 1, COLUMNS do
            cells[column] = 0
        end
        well[row] = cells
    end
    clearing = {}
    clear_timer = 0
    score = 0
    lines = 0
    level = 0
    over = false
    next_piece = math.random(#SHAPES)
    spawn()
end

function _init()
    local art = {}
    for _, block in BLOCKS do
        table.insert(art, block_art(block))
    end
    blocks = sheet(art, CELL, CELL)

    for _, shape in SHAPES do
        local rotations = {}
        local turned = shape
        for turn = 1, 4 do
            rotations[turn] = cells_of(turned)
            turned = rotate(turned)
        end
        table.insert(pieces, { size = #shape, rotations = rotations })
    end

    start_game()
end

-- Where the piece would come to rest if it fell from here.
local function landing(): number
    local y = piece_y
    while fits(piece, rotation, piece_x, y + 1) do
        y += 1
    end
    return y
end

local function lock_piece()
    for _, cell in pieces[piece].rotations[rotation] do
        local x = piece_x + cell[1]
        local y = piece_y + cell[2]
        if y >= 0 then
            well[y + 1][x + 1] = piece
        end
    end

    clearing = {}
    for row = 1, ROWS do
        local full = true
        for column = 1, COLUMNS do
            if well[row][column] == 0 then
                full = false
                break
            end
        end
        if full then
            table.insert(clearing, row)
        end
    end

    if #clearing > 0 then
        clear_timer = CLEAR_TIME
    else
        spawn()
    end
end

-- The rows that were full are taken out and the stack above each one falls
-- into its place, which is easiest to read as a rebuild from the bottom up.
local function collapse()
    local kept = {}
    for row = ROWS, 1, -1 do
        local cleared = false
        for _, full in clearing do
            if full == row then
                cleared = true
                break
            end
        end
        if not cleared then
            table.insert(kept, well[row])
        end
    end

    for row = ROWS, 1, -1 do
        local from = kept[ROWS - row + 1]
        if from then
            well[row] = from
        else
            local empty = {}
            for column = 1, COLUMNS do
                empty[column] = 0
            end
            well[row] = empty
        end
    end

    score += LINE_SCORE[#clearing] * (level + 1)
    lines += #clearing
    level = math.floor(lines / 10)
    clearing = {}
    spawn()
end

local function step_sideways(dt: number)
    local direction = 0
    if btn(BUTTON.LEFT) then
        direction -= 1
    end
    if btn(BUTTON.RIGHT) then
        direction += 1
    end

    if direction == 0 then
        held_direction = 0
        return
    end
    if direction ~= held_direction then
        held_direction = direction
        repeat_timer = REPEAT_DELAY
    else
        repeat_timer -= dt
        if repeat_timer > 0 then
            return
        end
        repeat_timer = REPEAT_RATE
    end
    if fits(piece, rotation, piece_x + direction, piece_y) then
        piece_x += direction
    end
end

-- A turn that would put the piece through a wall or the stack is tried again
-- a cell or two to the side before it is given up on.
local function turn_piece()
    local turned = rotation % 4 + 1
    for _, kick in { 0, -1, 1, -2, 2 } do
        if fits(piece, turned, piece_x + kick, piece_y) then
            rotation = turned
            piece_x += kick
            return
        end
    end
end

function _update(dt: number)
    if over then
        if btnp(BUTTON.START) then
            start_game()
        end
        return
    end

    if #clearing > 0 then
        clear_timer -= dt
        if clear_timer <= 0 then
            collapse()
        end
        return
    end

    step_sideways(dt)
    if btnp(BUTTON.A) or btnp(BUTTON.UP) then
        turn_piece()
    end
    if btnp(BUTTON.B) then
        local rest = landing()
        score += 2 * (rest - piece_y)
        piece_y = rest
        lock_piece()
        return
    end

    local interval = math.max(FALL_FLOOR, FALL_BY_LEVEL - level * 0.045)
    if btn(BUTTON.DOWN) then
        interval = math.min(interval, SOFT_DROP)
    end

    fall += dt
    while fall >= interval do
        fall -= interval
        if fits(piece, rotation, piece_x, piece_y + 1) then
            piece_y += 1
            if btn(BUTTON.DOWN) then
                score += 1
            end
        else
            lock_piece()
            return
        end
    end
end

local function draw_block(which: number, x: number, y: number)
    blocks:spr(which - 1, x, y)
end

local function draw_piece(which: number, turn: number, at_x: number, at_y: number)
    for _, cell in pieces[which].rotations[turn] do
        local y = at_y + cell[2]
        if y >= 0 then
            draw_block(which, WELL_X + (at_x + cell[1]) * CELL, WELL_Y + y * CELL)
        end
    end
end

function _draw()
    cls(0)

    rect(WELL_X - 1, WELL_Y - 1, COLUMNS * CELL + 2, ROWS * CELL + 2, 5)
    rectfill(WELL_X, WELL_Y, COLUMNS * CELL, ROWS * CELL, 1)

    for row = 1, ROWS do
        local y = WELL_Y + (row - 1) * CELL
        local flashing = false
        for _, full in clearing do
            if full == row then
                flashing = true
                break
            end
        end
        if flashing then
            rectfill(WELL_X, y, COLUMNS * CELL, CELL, 7)
        else
            for column = 1, COLUMNS do
                local block = well[row][column]
                if block ~= 0 then
                    draw_block(block, WELL_X + (column - 1) * CELL, y)
                end
            end
        end
    end

    if not over and #clearing == 0 then
        local rest = landing()
        if rest ~= piece_y then
            for _, cell in pieces[piece].rotations[rotation] do
                local y = rest + cell[2]
                if y >= 0 then
                    -- Two rings, so the ghost survives a display that has to
                    -- throw pixels away to fit.
                    local at_x = WELL_X + (piece_x + cell[1]) * CELL
                    local at_y = WELL_Y + y * CELL
                    rect(at_x, at_y, CELL, CELL, 5)
                    rect(at_x + 1, at_y + 1, CELL - 2, CELL - 2, 5)
                end
            end
        end
        draw_piece(piece, rotation, piece_x, piece_y)
    end

    text("NEXT", PANEL_X, 16, 6)
    rect(PANEL_X - 6, 28, 68, 68, 5)
    local preview = pieces[next_piece]
    local at_x = PANEL_X - 6 + 34 - preview.size * CELL / 2
    local at_y = 28 + 34 - preview.size * CELL / 2
    for _, cell in preview.rotations[1] do
        draw_block(next_piece, at_x + cell[1] * CELL, at_y + cell[2] * CELL)
    end

    text("SCORE", PANEL_X, 112, 6)
    text(tostring(score), PANEL_X, 128, 7)
    text("LINES", PANEL_X, 160, 6)
    text(tostring(lines), PANEL_X, 176, 7)
    text("LEVEL", PANEL_X, 208, 6)
    text(tostring(level), PANEL_X, 224, 7)

    if over then
        local final = "SCORE " .. score
        local middle = SCREEN_WIDTH / 2
        rectfill(20, 100, SCREEN_WIDTH - 40, 64, 0)
        rect(20, 100, SCREEN_WIDTH - 40, 64, 8)
        text("GAME OVER", middle - 27, 112, 8)
        text(final, middle - #final * 3, 128, 7)
        text("ENTER TO PLAY", middle - 39, 148, 6)
    end
end
