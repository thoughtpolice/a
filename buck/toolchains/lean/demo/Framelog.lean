-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

public import Framelog.Frame

/-!
# Framelog

The operations a program needs on a whole log, over `ByteArray`, and the
same operations exported to C (`framelog_*`) for C++ code and the fuzzer.
-/

namespace Framelog

open Frame

/-- The bytes of `data` as the proofs see them. -/
public def bytesOf (data : ByteArray) : List Nat :=
  data.toList.map (·.toNat)

/-- A frame around `payload`. -/
@[export framelog_frame]
public def frame (payload : ByteArray) : ByteArray :=
  toByteArray (encode (bytesOf payload))

/-- Every record of `log`, or `none` if any of it is damaged. -/
public def records (log : ByteArray) : Option (List ByteArray) :=
  (decodeAll (bytesOf log)).map (·.map toByteArray)

/-- How many whole frames `log` starts with, and how many bytes they take.
Recovery after a crash keeps those and drops the rest. -/
public def scan (log : ByteArray) : Nat × Nat :=
  go (bytesOf log).length (bytesOf log) 0 0
where
  go : Nat → List Nat → Nat → Nat → Nat × Nat
    | 0, _, count, used => (count, used)
    | fuel + 1, bytes, count, used =>
      match decode bytes with
      | some (_, rest) => go fuel rest (count + 1) (used + (bytes.length - rest.length))
      | none => (count, used)

/-! The exports below take ownership of their arguments, as exported Lean
functions do: C callers that keep the array pass it after `lean_inc`. -/

@[export framelog_intact_frames]
public def intactFrames (log : ByteArray) : UInt64 :=
  (scan log).1.toUInt64

@[export framelog_intact_bytes]
public def intactBytes (log : ByteArray) : UInt64 :=
  (scan log).2.toUInt64

/-- Whether `log` is either damaged or exactly the encoding of its records.
`Frame.replay` proves the converse direction; the fuzzer checks this one,
which says the format has one encoding per log. -/
@[export framelog_canonical]
public def canonical (log : ByteArray) : Bool :=
  match decodeAll (bytesOf log) with
  | some rs => encodeAll rs == bytesOf log
  | none => true

end Framelog
