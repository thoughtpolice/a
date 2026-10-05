-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

public import Split.Shapes

/-- Exits 0 when the areas, computed by code leanir generated, add up. -/
public def main : IO UInt32 := do
  let total := (Shape.square 3).area + (Shape.rect 4 5).area
  return if total == 29 then 0 else 1
