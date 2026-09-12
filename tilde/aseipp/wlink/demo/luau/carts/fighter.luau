-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

-- A one round fighting game. Both fighters are drawn from the same seven
-- poses, thirty-two by forty-eight: the art is written once with `g` and `t`
-- standing in for the gi and its trim, and each fighter has a sheet made by
-- dressing those poses in its own colours. Facing is the sprite's horizontal
-- flip, so a pose is only ever drawn one way round.
--
-- Left and right walk, Z punches, X kicks, down guards, and enter starts the
-- next round.

local IDLE = {
    "................................",
    "................................",
    ".............444444.............",
    "...........4444444444...........",
    "..........444444444444..........",
    "..........44ffffffff44..........",
    "..........4ffffffffff4..........",
    "..........4ff00ff00ff4..........",
    "..........4ff00ff00ff4..........",
    "..........4ffffffffff4..........",
    "...........ffff77ffff...........",
    "...........ffffffffff...........",
    "............ffffffff............",
    ".............ffffff.............",
    "..............ffff..............",
    "..............ffff..............",
    "........gggggggggggggggg........",
    "........gggggggggggggggg........",
    ".....tttgg7gggggggggg7ggttt.....",
    ".....tttggg7gggggggg7gggttt.....",
    ".....ggggggg77777777ggggggg.....",
    ".....gggggggggggggggggggggg.....",
    ".....gggggggggggggggggggggg.....",
    ".....ggggggggggggggggggggggtttt.",
    ".....gggt77777777777777tgggtttt.",
    ".....ffft77777777777777t...ffff.",
    ".....fffgggggggggggggggg...ffff.",
    ".....fffgggggggggggggggg...ffff.",
    "........gggggggggggggggg........",
    "........gggggggggggggggg........",
    "........ggggggg..ggggggg........",
    "........gggggg....gggggg........",
    "........gggg........gggg........",
    "........gggg........gggg........",
    "........gggg........gggg........",
    "........gggg........gggg........",
    "........gggg........gggg........",
    "........gggg........gggg........",
    "........gggg........gggg........",
    "........ffff........ffff........",
    "........ffff........ffff........",
    "........ffff........ffff........",
    "........ffff........ffff........",
    "........5555........5555........",
    "........5555........5555........",
    "........555555....555555........",
    "........555555....555555........",
    "........555555....555555........",
}

local STEP = {
    "................................",
    "................................",
    "................................",
    ".............444444.............",
    "...........4444444444...........",
    "..........444444444444..........",
    "..........44ffffffff44..........",
    "..........4ffffffffff4..........",
    "..........4ff00ff00ff4..........",
    "..........4ff00ff00ff4..........",
    "..........4ffffffffff4..........",
    "...........ffff77ffff...........",
    "...........ffffffffff...........",
    "............ffffffff............",
    ".............ffffff.............",
    "..............ffff..............",
    "..............ffff..............",
    "........gggggggggggggggg........",
    "........gggggggggggggggg........",
    ".....tttgg7gggggggggg7ggttt.....",
    ".....tttggg7gggggggg7gggttt.....",
    ".....ggggggg77777777ggggggg.....",
    ".....gggggggggggggggggggggg.....",
    ".....gggggggggggggggggggggg.....",
    ".....ggggggggggggggggggggggtttt.",
    ".....gggt77777777777777tgggtttt.",
    ".....ffft77777777777777t...ffff.",
    ".....fffgggggggggggggggg...ffff.",
    ".....fffgggggggggggggggg...ffff.",
    "........gggggggggggggggg........",
    "........gggggggggggggggg........",
    "........ggggggg..ggggggg........",
    "........gggggg....gggggg........",
    "........gggg.........ggg........",
    "........gggg.........ggg........",
    "........gggg.........ggg........",
    "........gggg.........ggg........",
    "........gggg..........gg........",
    "........gggg..........gg........",
    "........ffff..........gg........",
    "........ffff..........gg........",
    "........ffff..........gg........",
    "........ffff.........fff........",
    "........ffff.........fff........",
    "........5555.........fff........",
    "........5555.........fff........",
    "........555555......ffff........",
    "........555555....555555........",
}

local PUNCH = {
    "................................",
    "................................",
    ".............444444.............",
    "...........4444444444...........",
    "..........444444444444..........",
    "..........44ffffffff44..........",
    "..........4ffffffffff4..........",
    "..........4ff00ff00ff4..........",
    "..........4ff00ff00ff4..........",
    "..........4ffffffffff4..........",
    "...........ffff77ffff...........",
    "...........ffffffffff...........",
    "............ffffffff............",
    ".............ffffff.............",
    "..............ffff..............",
    "..............ffff..............",
    "........gggggggggggggggg........",
    "........gggggggggggggggg........",
    ".....tttgg7gggggggggg7gg........",
    ".....tttggg7gggggggg7ggg........",
    ".....ggggggg77777777ggttttgggggg",
    ".....gggggggggggggggggttttgggggg",
    ".....gggggggggggggggggggggffffff",
    ".....gggggggggggggggggggggffffff",
    ".....gggt77777777777777t..ffffff",
    ".....ffft77777777777777t..ffffff",
    ".....fffgggggggggggggggg........",
    ".....fffgggggggggggggggg........",
    "........gggggggggggggggg........",
    "........gggggggggggggggg........",
    "........ggggggg..ggggggg........",
    "........gggggg....gggggg........",
    "........gggg........gggg........",
    "........gggg........gggg........",
    "........gggg........gggg........",
    "........gggg........gggg........",
    "........gggg........gggg........",
    "........gggg........gggg........",
    "........gggg........gggg........",
    "........ffff........ffff........",
    "........ffff........ffff........",
    "........ffff........ffff........",
    "........ffff........ffff........",
    "........5555........5555........",
    "........5555........5555........",
    "........555555....555555........",
    "........555555....555555........",
    "........555555....555555........",
}

local KICK = {
    "................................",
    "................................",
    "...........444444...............",
    ".........4444444444.............",
    "........444444444444............",
    "........44ffffffff44............",
    "........4ffffffffff4............",
    "........4ff00ff00ff4............",
    "........4ff00ff00ff4............",
    "........4ffffffffff4............",
    ".........ffff77ffff.............",
    ".........ffffffffff.............",
    "..........ffffffff..............",
    "...........ffffff...............",
    "............ffff................",
    "............ffff................",
    "......gggggggggggggggg..........",
    "......gggggggggggggggg..........",
    "...tttgg7gggggggggg7ggttt.......",
    "...tttggg7gggggggg7gggttt.......",
    "...ggggggg77777777ggggggg.......",
    "...gggggggggggggggggggggg.......",
    "...gggggggggggggggggggggg.......",
    "...ggggggggggggggggggggggtttt...",
    "...gggt77777777777777tgggtttt...",
    "...ffft77777777777777t...ffff...",
    "...fffgggggggggggggggg...ffff...",
    "...fffgggggggggggggggg...ffff...",
    "......gggggggggggggggg..........",
    "......gggggggggggggggg..........",
    "......ggggggg..ggggggg..........",
    "......gggggg....gggggg..........",
    "......gggg......................",
    "......gggg......................",
    "......gggg..ggggggggggttttff5555",
    "......gggg..ggggggggggttttff5555",
    "......gggg..ggggggggggttttff5555",
    "......gggg..ggggggggggttttff5555",
    "......gggg......................",
    "......ffff......................",
    "......ffff......................",
    "......ffff......................",
    "......ffff......................",
    "......5555......................",
    "......5555......................",
    "......555555....................",
    "......555555....................",
    "......555555....................",
}

local BLOCK = {
    "................................",
    "................................",
    "................................",
    "................................",
    "............444444..............",
    "..........4444444444............",
    ".........444444444444...........",
    ".........44ffffffff44...........",
    ".........4ffffffffff4...........",
    ".........4ff00ff00ff4...........",
    ".........4ff00ff00ff4..tttt.....",
    ".........4ffffffffff4..tttt.....",
    "..........ffff77ffff...gggg.....",
    "..........ffffffffff...gggg.....",
    "...........ffffffff....ffff.....",
    "............ffffff.....ffff.....",
    ".............ffff......ffff.....",
    ".............ffff......ffff.....",
    ".......ggggggggggggggggffff.....",
    ".......ggggggggggggggggffff.....",
    "....tttgg7gggggggggg7ggffff.....",
    "....tttggg7gggggggg7gggffff.....",
    "....ggggggg77777777ggggffff.....",
    "....gggggggggggggggggggffff.....",
    "....ggggggggggggggggggg.........",
    "....ggggggggggggggggggg.........",
    "....gggt77777777777777t.........",
    "....ffft77777777777777t.........",
    "....fffgggggggggggggggg.........",
    "....fffgggggggggggggggg.........",
    ".......gggggggggggggggg.........",
    ".......gggggggggggggggg.........",
    ".......ggggggg..ggggggg.........",
    ".......gggggg....gggggg.........",
    ".......gggg........gggg.........",
    ".......gggg........gggg.........",
    ".......gggg........gggg.........",
    ".......gggg........gggg.........",
    ".......gggg........gggg.........",
    ".......gggg........gggg.........",
    ".......gggg........gggg.........",
    ".......ffff........ffff.........",
    ".......ffff........ffff.........",
    ".......ffff........ffff.........",
    ".......ffff........ffff.........",
    ".......5555........5555.........",
    ".......5555........5555.........",
    ".......555555....555555.........",
}

local HURT = {
    "................................",
    ".........444444.................",
    ".......4444444444...............",
    "......444444444444..............",
    "......44ffffffff44..............",
    "......4ffffffffff4..............",
    "......4ff00ff00ff4..............",
    "......4ff00ff00ff4..............",
    "......4ffffffffff4..............",
    ".......ffff77ffff...............",
    ".......ffffffffff...............",
    "........ffffffff................",
    ".........ffffff.................",
    "..........ffff..................",
    "..........ffff..................",
    "......................ttt.......",
    "......ggggggggggggggggttt.......",
    ".ttt..ggggggggggggggggggg.......",
    ".ttt..gg7gggggggggg7ggggg.......",
    ".ggg..ggg7gggggggg7gggfff.......",
    ".ggg..gggg77777777ggggfff.......",
    ".fff..gggggggggggggggg..........",
    ".fff..gggggggggggggggg..........",
    "......gggggggggggggggg..........",
    "......t77777777777777t..........",
    "......t77777777777777t..........",
    "......gggggggggggggggg..........",
    "......gggggggggggggggg..........",
    "......gggggggggggggggg..........",
    "......gggggggggggggggg..........",
    "......ggggggg..ggggggg..........",
    "......gggggg....gggggg..........",
    "......gggg........gggg..........",
    "......gggg........gggg..........",
    "......gggg........gggg..........",
    "......gggg........gggg..........",
    "......gggg........gggg..........",
    "......gggg........gggg..........",
    "......gggg........gggg..........",
    "......ffff........ffff..........",
    "......ffff........ffff..........",
    "......ffff........ffff..........",
    "......ffff........ffff..........",
    "......5555........5555..........",
    "......5555........5555..........",
    "......555555....555555..........",
    "......555555....555555..........",
    "......555555....555555..........",
}

local DOWN = {
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    ".......444444...................",
    ".....4444444444.................",
    "....444444444444................",
    "....44ffffffff44................",
    "....4ffffffffff4................",
    "....4ff00ff00ff4................",
    "....4ff00ff00ff4................",
    "....4ffffffffff4................",
    ".....ffff77ffff.................",
    ".....ffffffffff.................",
    "......ffffffff..................",
    ".......ffffff...................",
    "........ffff..ttt...............",
    "........ffff..ttt...............",
    "..ggggggggggggfffg..............",
    "..ggggggggggggfffg..............",
    "..gg7gggggggggg7gggggggg........",
    "..ggg7gggggggg7ggggggggg........",
    "..gggg77777777ggggggggggtttt....",
    "..ggggggggggggggggggggggtttt....",
    "..gggggggggggggggg..ffffffff....",
    "..gggggggggggggggg..ffffffff5555",
    "..t77777777777777t..ffffffff5555",
    "..t77777777777777t......ffff5555",
    "..gggggggggggggggg..........5555",
    "..gggggggggggggggg..........5555",
    "..gggggggggggggggg..............",
    "..gggggggggggggggg..............",
}

-- The hall: a speckled flagstone for the floor and a banded course for the
-- wall behind, both sixteen pixels square.
local FLOOR = {
    {
        "6666666666666666",
        "6555555555555556",
        "6551555555555556",
        "6555555555155556",
        "6555555555555556",
        "6555155555555556",
        "6555555555555556",
        "6555555551555556",
        "6555555555555556",
        "6551555555555556",
        "6555555555555556",
        "6555555515555556",
        "6555555555555556",
        "6555155555555556",
        "6555555555555556",
        "6666666666666666",
    },
    {
        "1111111111111111",
        "1111111111111111",
        "1dd1dd1dd1dd1dd1",
        "1dd1dd1dd1dd1dd1",
        "1111111111111111",
        "1111111111111111",
        "1dd1dd1dd1dd1dd1",
        "1dd1dd1dd1dd1dd1",
        "1111111111111111",
        "1111111111111111",
        "1111111111111111",
        "1111111111111111",
        "1111111111111111",
        "1111111111111111",
        "1111111111111111",
        "1111111111111111",
    },
}

local FIGHTER_W = 32
local FIGHTER_H = 48
local GROUND = 216
local ARENA_LEFT = 4
local ARENA_RIGHT = SCREEN_WIDTH - FIGHTER_W - 4
local WALK = 72
local ROUND_TIME = 60
local START_GAP = 92

-- Poses, in the order they go into a sheet.
local POSE_IDLE = 0
local POSE_STEP = 1
local POSE_PUNCH = 2
local POSE_KICK = 3
local POSE_BLOCK = 4
local POSE_HURT = 5
local POSE_DOWN = 6

-- An attack runs startup, then a window where it can land, then recovery.
-- Reach is between the fighters' middles.
local ATTACKS = {
    punch = { pose = POSE_PUNCH, startup = 0.07, active = 0.10, recover = 0.13, reach = 46, damage = 5, push = 8 },
    kick = { pose = POSE_KICK, startup = 0.13, active = 0.12, recover = 0.24, reach = 60, damage = 9, push = 18 },
}


local hex = "0123456789abcdef"

local function digit(color: number): string
    return string.sub(hex, color + 1, color + 1)
end

-- The same pose in one fighter's colours.
local function dressed(pose: { string }, gi: number, trim: number): { string }
    local out = {}
    for at, row in pose do
        local line = string.gsub(row, "g", digit(gi))
        line = string.gsub(line, "t", digit(trim))
        out[at] = line
    end
    return out
end

local POSES = { IDLE, STEP, PUNCH, KICK, BLOCK, HURT, DOWN }

local function fighter_sheet(gi: number, trim: number)
    local art = {}
    for _, pose in POSES do
        table.insert(art, dressed(pose, gi, trim))
    end
    return sheet(art, FIGHTER_W, FIGHTER_H)
end

type Fighter = {
    x: number,
    facing: number,
    health: number,
    state: string,
    timer: number,
    walked: number,
    struck: boolean,
    attack: any,
    think: number,
    guard: number,
    ai: boolean,
    sheets: any,
}

local one: Fighter
local two: Fighter
local clock = ROUND_TIME
local outcome = ""
local floor_tiles

local function new_fighter(x: number, facing: number, ai: boolean, sheets): Fighter
    return {
        x = x,
        facing = facing,
        health = 100,
        state = "idle",
        timer = 0,
        walked = 0,
        struck = false,
        attack = nil,
        think = 0,
        guard = 0,
        ai = ai,
        sheets = sheets,
    }
end

local function middle(who: Fighter): number
    return who.x + FIGHTER_W / 2
end

local function start_round()
    one.x = SCREEN_WIDTH / 2 - START_GAP / 2 - FIGHTER_W
    two.x = SCREEN_WIDTH / 2 + START_GAP / 2
    for _, who in { one, two } do
        who.health = 100
        who.state = "idle"
        who.timer = 0
        who.walked = 0
        who.struck = false
        who.attack = nil
        who.think = 0
        who.guard = 0
    end
    one.facing = 1
    two.facing = -1
    clock = ROUND_TIME
    outcome = ""
end

function _init()
    one = new_fighter(0, 1, false, fighter_sheet(12, 1))
    two = new_fighter(0, -1, true, fighter_sheet(8, 2))
    floor_tiles = sheet(FLOOR, 16, 16)
    start_round()
end

local function busy(who: Fighter): boolean
    return who.state == "punch" or who.state == "kick" or who.state == "hurt"
end

local function begin_attack(who: Fighter, name: string)
    if busy(who) then
        return
    end
    who.attack = ATTACKS[name]
    who.state = name
    who.timer = 0
    who.struck = false
end

local function walk(who: Fighter, direction: number, other: Fighter, dt: number)
    if busy(who) or who.state == "block" then
        return
    end
    local step = direction * WALK * dt
    local to = math.clamp(who.x + step, ARENA_LEFT, ARENA_RIGHT)
    -- Neither fighter walks through the other.
    if math.abs((to + FIGHTER_W / 2) - middle(other)) >= 28 or math.abs(to - other.x) > math.abs(who.x - other.x) then
        who.x = to
    end
    who.state = "walk"
    who.walked += math.abs(step)
end

local function take_hit(who: Fighter, from: Fighter, attack, blocked: boolean)
    local damage = if blocked then 1 else attack.damage
    who.health = math.max(0, who.health - damage)
    local push = if blocked then attack.push / 2 else attack.push
    who.x = math.clamp(who.x + from.facing * push, ARENA_LEFT, ARENA_RIGHT)
    if not blocked then
        who.state = "hurt"
        who.timer = 0
        who.attack = nil
    end
end

-- The AI walks in, throws something when it is close enough, and puts its
-- guard up when it sees an attack coming.
local function think(who: Fighter, other: Fighter, dt: number)
    who.think -= dt
    who.guard -= dt
    if busy(who) then
        return
    end
    if who.guard > 0 then
        who.state = "block"
        return
    end

    local gap = math.abs(middle(other) - middle(who))
    local toward = if middle(other) > middle(who) then 1 else -1

    if (other.state == "punch" or other.state == "kick") and gap < 68 and math.random() < 0.55 then
        who.state = "block"
        who.guard = 0.28
        return
    end
    if who.think > 0 then
        return
    end

    if gap > 60 then
        walk(who, toward, other, dt)
        who.think = 0
    elseif gap > 48 then
        if math.random() < 0.5 then
            begin_attack(who, "kick")
        else
            walk(who, toward, other, dt)
        end
        who.think = 0.2
    else
        local choice = math.random()
        if choice < 0.45 then
            begin_attack(who, "punch")
        elseif choice < 0.6 then
            begin_attack(who, "kick")
        elseif choice < 0.75 then
            walk(who, -toward, other, dt)
        else
            who.state = "block"
            who.guard = 0.3
        end
        who.think = 0.3
    end
end

local function control(who: Fighter, other: Fighter, dt: number)
    if busy(who) then
        return
    end
    if btn(BUTTON.DOWN) then
        who.state = "block"
        return
    end
    if btnp(BUTTON.A) then
        begin_attack(who, "punch")
        return
    end
    if btnp(BUTTON.B) then
        begin_attack(who, "kick")
        return
    end
    if btn(BUTTON.LEFT) then
        walk(who, -1, other, dt)
    elseif btn(BUTTON.RIGHT) then
        walk(who, 1, other, dt)
    end
end

-- Runs the clock on whatever a fighter is in the middle of, and lands an
-- attack the one time its window is open and the other is in range.
local function advance(who: Fighter, other: Fighter, dt: number)
    who.timer += dt
    if who.state == "punch" or who.state == "kick" then
        local attack = who.attack
        local open = who.timer >= attack.startup and who.timer < attack.startup + attack.active
        if open and not who.struck then
            local gap = math.abs(middle(other) - middle(who))
            local ahead = (middle(other) - middle(who)) * who.facing >= 0
            if gap <= attack.reach and ahead and other.state ~= "down" then
                who.struck = true
                take_hit(other, who, attack, other.state == "block")
            end
        end
        if who.timer >= attack.startup + attack.active + attack.recover then
            who.state = "idle"
            who.attack = nil
        end
    elseif who.state == "hurt" then
        if who.timer >= 0.3 then
            who.state = "idle"
        end
    end
end

function _update(dt: number)
    if outcome ~= "" then
        if btnp(BUTTON.START) then
            start_round()
        end
        return
    end

    -- A fighter's state lasts until something sets it again, so the ones that
    -- are only true while a button is held start the frame cleared.
    for _, who in { one, two } do
        if who.state == "walk" or who.state == "block" then
            who.state = "idle"
        end
    end

    if not busy(one) then
        one.facing = if middle(two) >= middle(one) then 1 else -1
    end
    if not busy(two) then
        two.facing = if middle(one) > middle(two) then 1 else -1
    end

    control(one, two, dt)
    think(two, one, dt)
    advance(one, two, dt)
    advance(two, one, dt)

    clock -= dt
    if one.health <= 0 or two.health <= 0 then
        local loser = if one.health <= 0 then one else two
        loser.state = "down"
        outcome = if one.health <= 0 and two.health <= 0 then "DRAW" else "K.O."
    elseif clock <= 0 then
        clock = 0
        outcome = if one.health == two.health then "DRAW" elseif one.health > two.health then "TIME - P1" else "TIME - P2"
    end
end

local function pose_of(who: Fighter): number
    if who.state == "down" then
        return POSE_DOWN
    elseif who.state == "hurt" then
        return POSE_HURT
    elseif who.state == "block" then
        return POSE_BLOCK
    elseif who.state == "punch" then
        return POSE_PUNCH
    elseif who.state == "kick" then
        return POSE_KICK
    elseif who.state == "walk" then
        return if who.walked % 32 < 16 then POSE_STEP else POSE_IDLE
    end
    return POSE_IDLE
end

local function draw_bar(x: number, health: number, flip: boolean)
    local width = 100
    local filled = math.floor(width * health / 100)
    rectfill(x, 16, width, 12, 5)
    if filled > 0 then
        local color = if health > 50 then 11 elseif health > 20 then 10 else 8
        rectfill(if flip then x + width - filled else x, 16, filled, 12, color)
    end
    rect(x - 2, 14, width + 4, 16, 6)
end

function _draw()
    cls(0)

    -- The hall: a dark ceiling over a lit wall, pillars down the back of it,
    -- a banded course along the top, and the flagstones they fight on.
    rectfill(0, 96, SCREEN_WIDTH, GROUND - 96, 1)
    for pillar = 0, 4 do
        rectfill(14 + pillar * 56, 112, 16, GROUND - 112, 5)
        rectfill(14 + pillar * 56, 112, 3, GROUND - 112, 6)
    end
    floor_tiles:map({ "1111111111111111", "1111111111111111" }, 0, 96)
    rectfill(0, GROUND, SCREEN_WIDTH, 6, 4)
    floor_tiles:map({ "0000000000000000", "0000000000000000", "0000000000000000" }, 0, GROUND + 6)

    for _, who in { one, two } do
        who.sheets:spr(pose_of(who), who.x, GROUND - FIGHTER_H, who.facing < 0)
    end

    draw_bar(4, one.health, false)
    draw_bar(SCREEN_WIDTH - 104, two.health, true)
    text("P1", 4, 2, 12)
    text("P2", SCREEN_WIDTH - 16, 2, 8)
    local middle = SCREEN_WIDTH / 2
    local ticks = tostring(math.ceil(clock))
    text(ticks, middle - #ticks * 3, 18, 7)

    if outcome ~= "" then
        rectfill(20, 100, SCREEN_WIDTH - 40, 64, 0)
        rect(20, 100, SCREEN_WIDTH - 40, 64, 8)
        text(outcome, middle - #outcome * 3, 118, 10)
        text("ENTER TO PLAY", middle - 39, 140, 6)
    end
end
