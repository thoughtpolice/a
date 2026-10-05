-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

public inductive Shape where
  | square (side : Nat)
  | rect (w h : Nat)

public def Shape.area : Shape → Nat
  | .square s => s * s
  | .rect w h => w * h
