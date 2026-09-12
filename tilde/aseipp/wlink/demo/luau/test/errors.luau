-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

-- A cart that fails on purpose, to show what a console does about it: first
-- the errors a cart handles itself, and then, a few frames in, one it does
-- not. Drawing before the failure gives the two hosts frames to disagree
-- about, if they were going to.

local frames = 0

function _init()
    local ok, message = pcall(function()
        error("thrown on purpose")
    end)
    print("handled=" .. tostring(ok) .. " message=" .. tostring(message))

    local fine, runtime = pcall(function()
        local nothing = nil
        return nothing.field
    end)
    print("handled=" .. tostring(fine) .. " message=" .. tostring(runtime))

    -- A handler may run after the error, and the cart carries on.
    local total = 0
    for attempt = 1, 3 do
        local worked = pcall(function()
            if attempt == 2 then
                error("only the second")
            end
            total += attempt
        end)
        if not worked then
            total += 100
        end
    end
    print("total=" .. total)
end

function _update()
    frames += 1
    if frames == 3 then
        -- Nothing protects this one, so the console has to.
        local gone = nil
        gone.field = 1
    end
end

function _draw()
    cls(1)
    rectfill(16, 16, 64, 64, 8)
    text("ERRORS", 24, 96, 7)
end
