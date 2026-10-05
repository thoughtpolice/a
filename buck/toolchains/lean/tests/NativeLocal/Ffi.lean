-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

public import Greeting.Basic

/-- The C function behind :native's mulAdd, bound again in this library. -/
@[extern "depot_lean_mul_add"]
public opaque fma (a b c : UInt32) : UInt32

/-- Native code calling into :greeting. -/
public def answerPlus (x : UInt32) : UInt32 :=
  fma 1 answer.toUInt32 x
