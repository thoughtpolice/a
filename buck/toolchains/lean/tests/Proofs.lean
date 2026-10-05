-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

public import Greeting.Basic
-- `meta` makes `answer`'s code available to the interpreter at elaboration
-- time, so the build hands this module its imports' IR.
meta import Greeting.Basic

theorem add_comm' (a b : Nat) : a + b = b + a := by omega

theorem rev_rev (xs : List Nat) : xs.reverse.reverse = xs := by simp

theorem answer_eq : answer = 6 * 7 := rfl

#guard answer == 42
#guard greet "proofs" == "hello, proofs"
