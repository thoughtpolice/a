-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

-- A cart for the console: paddle on the left and right arrows, a ball, and
-- a wall to clear. Draws on the 128x128 display through the prelude.

local BRICK_ROWS = 6
local BRICK_COLUMNS = 10
local BRICK_WIDTH = 24
local BRICK_HEIGHT = 12
local BRICK_TOP = 40
local PADDLE_WIDTH = 44
local PADDLE_HEIGHT = 6
local PADDLE_Y = 236
local BALL_RADIUS = 4

type Brick = { x: number, y: number, alive: boolean, color: number }

local bricks: { Brick } = {}
local paddle_x = 0.0
local ball_x = 0.0
local ball_y = 0.0
local ball_dx = 0.0
local ball_dy = 0.0
local score = 0
local lives = 3
local won = false

local function reset_ball()
    ball_x = SCREEN_WIDTH / 2
    ball_y = PADDLE_Y - 16
    ball_dx = 84.0
    ball_dy = -104.0
end

local function build_wall()
    bricks = {}
    for row = 0, BRICK_ROWS - 1 do
        for column = 0, BRICK_COLUMNS - 1 do
            table.insert(bricks, {
                x = 3 + column * (BRICK_WIDTH + 1),
                y = BRICK_TOP + row * (BRICK_HEIGHT + 3),
                alive = true,
                color = 8 + row,
            })
        end
    end
end

function _init()
    paddle_x = (SCREEN_WIDTH - PADDLE_WIDTH) / 2
    build_wall()
    reset_ball()
end

local function bounce_off_bricks()
    for _, brick in bricks do
        if brick.alive
            and ball_x + BALL_RADIUS >= brick.x
            and ball_x - BALL_RADIUS <= brick.x + BRICK_WIDTH
            and ball_y + BALL_RADIUS >= brick.y
            and ball_y - BALL_RADIUS <= brick.y + BRICK_HEIGHT
        then
            brick.alive = false
            ball_dy = -ball_dy
            score += 10
            return
        end
    end
end

function _update(dt: number)
    if won or lives <= 0 then
        return
    end

    local speed = 220 * dt
    if btn(BUTTON.LEFT) then
        paddle_x -= speed
    end
    if btn(BUTTON.RIGHT) then
        paddle_x += speed
    end
    paddle_x = math.clamp(paddle_x, 0, SCREEN_WIDTH - PADDLE_WIDTH)

    ball_x += ball_dx * dt
    ball_y += ball_dy * dt

    if ball_x < BALL_RADIUS then
        ball_x = BALL_RADIUS
        ball_dx = -ball_dx
    elseif ball_x > SCREEN_WIDTH - BALL_RADIUS then
        ball_x = SCREEN_WIDTH - BALL_RADIUS
        ball_dx = -ball_dx
    end
    if ball_y < BALL_RADIUS then
        ball_y = BALL_RADIUS
        ball_dy = -ball_dy
    end

    -- The paddle sends the ball off at an angle set by where it was struck.
    if ball_dy > 0
        and ball_y + BALL_RADIUS >= PADDLE_Y
        and ball_y - BALL_RADIUS <= PADDLE_Y + PADDLE_HEIGHT
        and ball_x >= paddle_x
        and ball_x <= paddle_x + PADDLE_WIDTH
    then
        local hit = (ball_x - (paddle_x + PADDLE_WIDTH / 2)) / (PADDLE_WIDTH / 2)
        ball_dy = -math.abs(ball_dy)
        ball_dx = 140 * hit
        ball_y = PADDLE_Y - BALL_RADIUS - 1
    end

    bounce_off_bricks()

    if ball_y > SCREEN_HEIGHT then
        lives -= 1
        reset_ball()
    end

    local remaining = 0
    for _, brick in bricks do
        if brick.alive then
            remaining += 1
        end
    end
    won = remaining == 0
end

function _draw()
    cls(1)

    for _, brick in bricks do
        if brick.alive then
            rectfill(brick.x, brick.y, BRICK_WIDTH, BRICK_HEIGHT, brick.color)
        end
    end

    rectfill(paddle_x, PADDLE_Y, PADDLE_WIDTH, PADDLE_HEIGHT, 12)
    circfill(ball_x, ball_y, BALL_RADIUS, 7)

    line(0, 24, SCREEN_WIDTH, 24, 5)
    text("SCORE " .. score, 4, 6, 7)
    text("LIVES " .. lives, SCREEN_WIDTH - 46, 6, 7)

    if won then
        text("YOU WIN", SCREEN_WIDTH / 2 - 21, 120, 10)
    elseif lives <= 0 then
        text("GAME OVER", SCREEN_WIDTH / 2 - 27, 120, 8)
    end
end
