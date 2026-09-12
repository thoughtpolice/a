-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

-- Exercises the parts of the interpreter a cart leans on: closures and
-- recursion, tables, string handling, the numeric library, and varargs.

local function fib(n: number): number
    if n < 2 then
        return n
    end
    return fib(n - 1) + fib(n - 2)
end

local function sum(...: number): number
    local total = 0
    for _, value in { ... } do
        total += value
    end
    return total
end

local squares = {}
for i = 1, 10 do
    squares[i] = i * i
end

local words = {}
for index, value in squares do
    table.insert(words, string.format("%d:%d", index, value))
end

local report = table.concat(words, ",")
assert(#squares == 10, "table length")
assert(squares[10] == 100, "table contents")
assert(report:sub(1, 3) == "1:1", "string formatting")
assert(report:sub(-6) == "10:100", "table.concat")
assert(sum(1, 2, 3, 4) == 10, "varargs")
assert(math.floor(math.sqrt(144)) == 12, "math library")
assert(select("#", 1, 2, 3) == 3, "select")

return fib(20)
