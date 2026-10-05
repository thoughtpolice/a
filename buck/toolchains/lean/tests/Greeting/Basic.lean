-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

public def greet (name : String) : String :=
  s!"hello, {name}"

-- Exposed, so importers can unfold it (Proofs.lean proves `answer = 6 * 7`
-- by `rfl`).
@[expose] public def answer : Nat := 42

public theorem answer_pos : 0 < answer := by decide
