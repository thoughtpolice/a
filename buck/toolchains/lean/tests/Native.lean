-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

/-- Implemented in C, in `native.c`. -/
@[extern "depot_lean_mul_add"]
public opaque mulAdd (a b c : UInt32) : UInt32
