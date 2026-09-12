-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

-- A vertical shooter. Everything that moves is a sixteen by sixteen sprite out
-- of one sheet, drawn two frames to the thing so the ships have some life in
-- them, over three layers of stars that scroll at their own speeds to give the
-- field some depth. The blasts are the one piece of art the cart works out for
-- itself, as two fireballs of different sizes.
--
-- Arrows fly, Z fires, and enter starts the next run.

local PLAYER = {
    {
        ".......cc.......",
        "......cccc......",
        "......c77c......",
        ".....cc77cc.....",
        ".....cccccc.....",
        "....cc6cc6cc....",
        "...ccc6cc6ccc...",
        "..cccccccccccc..",
        ".cccccccccccccc.",
        "cc.cccccccccc.cc",
        "c...cc9999cc...c",
        "....c9aaaa9c....",
        ".....9aaaa9.....",
        "......9aa9......",
        ".......99.......",
        "................",
    },
    {
        ".......cc.......",
        "......cccc......",
        "......c77c......",
        ".....cc77cc.....",
        ".....cccccc.....",
        "....cc6cc6cc....",
        "...ccc6cc6ccc...",
        "..cccccccccccc..",
        ".cccccccccccccc.",
        "cc.cccccccccc.cc",
        "c...cc9999cc...c",
        "....c99aa99c....",
        ".....9aaaa9.....",
        "......9aa9......",
        "................",
        "................",
    },
}

local DRIFTER = {
    {
        "................",
        ".33..........33.",
        ".333........333.",
        ".3333......3333.",
        "..333bbbbbb333..",
        "...3bbbbbbbb3...",
        "...bbbbbbbbbb...",
        "..bb88bbbb88bb..",
        "..bb88bbbb88bb..",
        "...bbbbbbbbbb...",
        "....bbbbbbbb....",
        "....b3bbbb3b....",
        ".....bbbbbb.....",
        "......bbbb......",
        ".......bb.......",
        "................",
    },
    {
        "................",
        "................",
        "..3..........3..",
        ".33..........33.",
        ".333bbbbbbbb333.",
        "..3bbbbbbbbbb3..",
        "...bbbbbbbbbb...",
        "..bb88bbbb88bb..",
        "..bb88bbbb88bb..",
        "...bbbbbbbbbb...",
        "....bbbbbbbb....",
        "...3b3bbbb3b3...",
        "..33.bbbbbb.33..",
        "......bbbb......",
        ".......bb.......",
        "................",
    },
}

local DIVER = {
    {
        "................",
        "................",
        "...e........e...",
        "...ee......ee...",
        "...eee....eee...",
        "...eeee..eeee...",
        "2.eeeeeeeeeeee.2",
        ".2eeeeeeeeeeee2.",
        "..eeeeeeeeeeee..",
        "...eeeaaaaeee...",
        "....eeaaaaee....",
        ".....eeeeee.....",
        ".....ee22ee.....",
        "......e22e......",
        "......eeee......",
        ".......ee.......",
    },
    {
        "................",
        "................",
        "..e..........e..",
        "..ee........ee..",
        "..eee......eee..",
        "..eeeee..eeeee..",
        "2.eeeeeeeeeeee.2",
        ".2eeeeeeeeeeee2.",
        "..eeeeeeeeeeee..",
        "...eee8888eee...",
        "....ee8888ee....",
        ".....eeeeee.....",
        ".....ee22ee.....",
        "......e22e......",
        "......eeee......",
        ".......ee.......",
    },
}

local SPRITE = 16
local PLAYER_SPEED = 136
local SHOT_SPEED = 300
local ENEMY_SHOT_SPEED = 124
local FIRE_DELAY = 0.22
local INVULNERABLE = 1.4
local WAVE_TIME = 12
local SHOT_W = 4
local SHOT_H = 8

-- Sprites are laid out in the order the art is given to the sheet.
local TILE_PLAYER = 0
local TILE_DRIFTER = 2
local TILE_DIVER = 4
local TILE_BLAST = 6

type Body = { x: number, y: number, dx: number, dy: number, kind: number, phase: number,
              fire: number, life: number }

local sprites
local stars: { { x: number, y: number, speed: number, shade: number, size: number } } = {}
local shots: { Body } = {}
local enemy_shots: { Body } = {}
local enemies: { Body } = {}
local blasts: { Body } = {}

local player_x = 0.0
local player_y = 0.0
local cooldown = 0.0
local safe = 0.0
local lives = 3
local score = 0
local wave = 1
local elapsed = 0.0
local spawn_timer = 0.0
local banner = 0.0
local over = false

-- A fireball: a rim, a body and a hot centre, which is all an explosion needs
-- to be at this size and is easier to size up than to draw twice.
local function blast_art(radius: number, core: number): { string }
    local rows = {}
    for y = 0, SPRITE - 1 do
        local row = ""
        for x = 0, SPRITE - 1 do
            local dx = x - (SPRITE - 1) / 2
            local dy = y - (SPRITE - 1) / 2
            local distance = math.sqrt(dx * dx + dy * dy)
            if distance > radius then
                row ..= "."
            elseif distance > radius - 1.6 then
                row ..= "a"
            elseif distance > core then
                row ..= "9"
            else
                row ..= "8"
            end
        end
        rows[y + 1] = row
    end
    return rows
end

local function overlaps(ax: number, ay: number, aw: number, ah: number,
                        bx: number, by: number, bw: number, bh: number): boolean
    return ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah
end

local function add_blast(x: number, y: number)
    table.insert(blasts, { x = x, y = y, dx = 0, dy = 0, kind = 0, phase = 0, fire = 0, life = 0.3 })
end

local function start_game()
    shots = {}
    enemy_shots = {}
    enemies = {}
    blasts = {}
    player_x = SCREEN_WIDTH / 2 - SPRITE / 2
    player_y = SCREEN_HEIGHT - 40
    cooldown = 0
    safe = 0
    lives = 3
    score = 0
    wave = 1
    elapsed = 0
    spawn_timer = 1
    banner = 1.5
    over = false
end

function _init()
    sprites = sheet({ PLAYER[1], PLAYER[2], DRIFTER[1], DRIFTER[2], DIVER[1], DIVER[2],
                      blast_art(5, 2), blast_art(7.5, 3.5) }, SPRITE, SPRITE)

    for _ = 1, 90 do
        local layer = math.random(3)
        table.insert(stars, {
            x = math.random(0, SCREEN_WIDTH - 1),
            y = math.random(0, SCREEN_HEIGHT - 1),
            speed = 20 + layer * 32,
            shade = 4 + layer,
            size = if layer == 3 then 2 else 1,
        })
    end

    start_game()
end

local function spawn_enemy()
    local diving = math.random() < math.min(0.55, 0.15 + wave * 0.08)
    local x = math.random(8, SCREEN_WIDTH - SPRITE - 8)
    table.insert(enemies, {
        x = x,
        y = -SPRITE,
        dx = if diving then 0 else 36 + math.random(0, 24),
        dy = if diving then 92 + wave * 6 else 44 + wave * 4,
        kind = if diving then 2 else 1,
        phase = math.random() * 6.28,
        fire = 1 + math.random() * 2,
        life = 0,
    })
end

local function hit_player()
    if safe > 0 then
        return
    end
    add_blast(player_x, player_y)
    lives -= 1
    safe = INVULNERABLE
    enemy_shots = {}
    if lives <= 0 then
        over = true
    end
end

function _update(dt: number)
    for _, star in stars do
        star.y += star.speed * dt
        if star.y >= SCREEN_HEIGHT then
            star.y -= SCREEN_HEIGHT
            star.x = math.random(0, SCREEN_WIDTH - 1)
        end
    end

    for at = #blasts, 1, -1 do
        local blast = blasts[at]
        blast.life -= dt
        if blast.life <= 0 then
            table.remove(blasts, at)
        end
    end

    if over then
        if btnp(BUTTON.START) then
            start_game()
        end
        return
    end

    elapsed += dt
    wave = 1 + math.floor(elapsed / WAVE_TIME)
    banner -= dt
    safe = math.max(0, safe - dt)
    cooldown = math.max(0, cooldown - dt)

    if btn(BUTTON.LEFT) then
        player_x -= PLAYER_SPEED * dt
    end
    if btn(BUTTON.RIGHT) then
        player_x += PLAYER_SPEED * dt
    end
    if btn(BUTTON.UP) then
        player_y -= PLAYER_SPEED * dt
    end
    if btn(BUTTON.DOWN) then
        player_y += PLAYER_SPEED * dt
    end
    player_x = math.clamp(player_x, 4, SCREEN_WIDTH - SPRITE - 4)
    player_y = math.clamp(player_y, 128, SCREEN_HEIGHT - SPRITE - 4)

    if btn(BUTTON.A) and cooldown <= 0 then
        cooldown = FIRE_DELAY
        table.insert(shots, { x = player_x + SPRITE / 2 - SHOT_W / 2, y = player_y - 4,
                              dx = 0, dy = -SHOT_SPEED, kind = 0, phase = 0, fire = 0, life = 0 })
    end

    spawn_timer -= dt
    if spawn_timer <= 0 then
        spawn_enemy()
        spawn_timer = math.max(0.3, 1.3 - wave * 0.09)
    end

    for at = #shots, 1, -1 do
        local shot = shots[at]
        shot.y += shot.dy * dt
        if shot.y < -SHOT_H then
            table.remove(shots, at)
        end
    end

    for at = #enemy_shots, 1, -1 do
        local shot = enemy_shots[at]
        shot.x += shot.dx * dt
        shot.y += shot.dy * dt
        if shot.y > SCREEN_HEIGHT or shot.x < -SHOT_W or shot.x > SCREEN_WIDTH then
            table.remove(enemy_shots, at)
        end
    end

    for at = #enemies, 1, -1 do
        local enemy = enemies[at]
        enemy.y += enemy.dy * dt
        if enemy.kind == 1 then
            -- A drifter sweeps across the field as it comes down.
            enemy.phase += dt * 2.2
            enemy.x += math.sin(enemy.phase) * enemy.dx * dt
        else
            -- A diver leans towards wherever the player is.
            enemy.x += math.clamp(player_x - enemy.x, -68, 68) * dt
        end
        enemy.x = math.clamp(enemy.x, 0, SCREEN_WIDTH - SPRITE)

        enemy.fire -= dt
        if enemy.fire <= 0 and enemy.y > 0 and enemy.y < SCREEN_HEIGHT - 80 then
            enemy.fire = 1.4 + math.random() * 2.2
            local dx = player_x - enemy.x
            local dy = math.max(32, player_y - enemy.y)
            local reach = math.sqrt(dx * dx + dy * dy)
            table.insert(enemy_shots, {
                x = enemy.x + SPRITE / 2 - SHOT_W / 2,
                y = enemy.y + SPRITE,
                dx = dx / reach * ENEMY_SHOT_SPEED,
                dy = dy / reach * ENEMY_SHOT_SPEED,
                kind = 0, phase = 0, fire = 0, life = 0,
            })
        end

        if enemy.y > SCREEN_HEIGHT then
            table.remove(enemies, at)
            continue
        end

        local dead = false
        for shot_at = #shots, 1, -1 do
            local shot = shots[shot_at]
            if overlaps(enemy.x + 2, enemy.y + 2, SPRITE - 4, SPRITE - 4, shot.x, shot.y, SHOT_W, SHOT_H) then
                table.remove(shots, shot_at)
                dead = true
                break
            end
        end
        if not dead and safe <= 0
            and overlaps(enemy.x + 2, enemy.y + 2, SPRITE - 4, SPRITE - 4,
                         player_x + 3, player_y + 3, SPRITE - 6, SPRITE - 6)
        then
            dead = true
            hit_player()
        end
        if dead then
            add_blast(enemy.x, enemy.y)
            score += if enemy.kind == 2 then 25 else 10
            table.remove(enemies, at)
        end
    end

    for at = #enemy_shots, 1, -1 do
        local shot = enemy_shots[at]
        if safe <= 0 and overlaps(player_x + 3, player_y + 3, SPRITE - 6, SPRITE - 6,
                                  shot.x, shot.y, SHOT_W, SHOT_H - 2)
        then
            table.remove(enemy_shots, at)
            hit_player()
        end
    end
end

function _draw()
    cls(0)

    for _, star in stars do
        rectfill(star.x, star.y, star.size, star.size, star.shade)
    end

    for _, shot in shots do
        rectfill(shot.x, shot.y, SHOT_W, SHOT_H, 10)
        rectfill(shot.x + 1, shot.y - 2, SHOT_W - 2, SHOT_H, 7)
    end
    for _, shot in enemy_shots do
        rectfill(shot.x, shot.y, SHOT_W, SHOT_H - 2, 8)
        rectfill(shot.x + 1, shot.y + 1, SHOT_W - 2, SHOT_H - 4, 14)
    end

    local beat = frame() // 6 % 2
    for _, enemy in enemies do
        local tile = if enemy.kind == 2 then TILE_DIVER else TILE_DRIFTER
        sprites:spr(tile + beat, enemy.x, enemy.y)
    end

    -- The ship blinks while it cannot be hit, which is also how a player can
    -- tell the difference.
    if not over and (safe <= 0 or frame() % 8 < 4) then
        sprites:spr(TILE_PLAYER + beat, player_x, player_y)
    end

    for _, blast in blasts do
        sprites:spr(TILE_BLAST + (if blast.life > 0.15 then 1 else 0), blast.x, blast.y)
    end

    text("SCORE " .. score, 4, 4, 7)
    for life = 1, lives do
        sprites:spr(TILE_PLAYER, SCREEN_WIDTH - life * 20, 2)
    end

    if banner > 0 then
        local label = "WAVE " .. wave
        text(label, SCREEN_WIDTH / 2 - #label * 3, 112, 10)
    end

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
