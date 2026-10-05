-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

public import Greeting.Basic

/-- Implemented in C, in `native.c`. -/
@[extern "depot_lean_mul_add"]
public opaque mulAdd (a b c : UInt32) : UInt32

/-- Native code calling into :greeting, so loading :native's shared object
takes :greeting's too. -/
public def answerTimes (x : UInt32) : UInt32 :=
  mulAdd x answer.toUInt32 0
