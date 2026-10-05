-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

public import Greeting.Basic

/-- Called from C++ in `interop.cpp`. -/
@[export depot_lean_greeting]
public def greeting (name : String) : String :=
  greet name ++ s!" ({answer})"
