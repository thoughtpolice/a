# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
function fib(n) { return n < 2 ? n : fib(n-1) + fib(n-2) }
BEGIN {
    a["x", 7] = 42; a["unused"] = 1; delete a["unused"]
    for (key in a) n++
    print a["x", 7], n, ("unused" in a), fib(12)
    s = "a12 b34"; gsub(/[0-9]+/, "N", s); print s
    print gensub(/([a-z]+)([0-9]+)/, "\\2-\\1", "g", "ab12 cd34")
    n = split("one::three", a, ":"); print n, length(a[2]), a[3]
    print match("prefix123suffix", /[0-9]+/), RSTART, RLENGTH
}
