-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0


-- Not a `module`: a plain file importing module files, which needs their IR.
import Greeting
import Native

def main (args : List String) : IO UInt32 := do
  IO.println (greeting "lean")
  IO.println s!"mulAdd 6 7 0 = {mulAdd 6 7 0}"
  return if args.isEmpty then 0 else 1
