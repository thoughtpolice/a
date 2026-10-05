-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

/-!
# Varints

LEB128 unsigned integers: seven bits per byte, low group first, with the
high bit set on every byte but the last. Bytes are `Nat`s below 256, which
keeps the proofs in plain arithmetic; `Framelog.Frame` converts at the edge.
-/

namespace Framelog.Varint

/-- The bytes of `n`. -/
public def encode (n : Nat) : List Nat :=
  if n < 128 then [n] else (n % 128 + 128) :: encode (n / 128)
termination_by n
decreasing_by omega

/-- Reads one varint off the front of `bytes`, returning it and what follows.

Only the encoding `encode` produces is accepted: a continuation byte must
not be followed by a group of zeroes, so every number has one encoding. -/
public def decode : List Nat → Option (Nat × List Nat)
  | [] => none
  | b :: rest =>
    if b < 128 then some (b, rest)
    else if b < 256 then
      match decode rest with
      | some (n, rest') => if n = 0 then none else some (b - 128 + 128 * n, rest')
      | none => none
    else none

public theorem encode_ne_nil (n : Nat) : encode n ≠ [] := by
  rw [encode]; split <;> simp

/-- Every byte of an encoding is a byte. -/
public theorem encode_lt (n : Nat) : ∀ b ∈ encode n, b < 256 := by
  induction n using Nat.strongRecOn with
  | _ n ih =>
    rw [encode]
    split
    · simp; omega
    · intro b hb
      simp only [List.mem_cons] at hb
      rcases hb with rfl | hb
      · omega
      · exact ih (n / 128) (by omega) b hb

/-- Decoding an encoding gives back the number and leaves the rest alone. -/
public theorem decode_encode (n : Nat) (rest : List Nat) :
    decode (encode n ++ rest) = some (n, rest) := by
  induction n using Nat.strongRecOn with
  | _ n ih =>
    rw [encode]
    split
    · simp [decode, *]
    · have hq : n / 128 < n := by omega
      simp only [List.cons_append, decode, ih (n / 128) hq]
      have h1 : ¬ (n % 128 + 128 < 128) := by omega
      have h2 : n % 128 + 128 < 256 := by omega
      have h3 : n / 128 ≠ 0 := by omega
      simp only [h1, h2, h3, ite_false, ite_true]
      congr 2
      omega

end Framelog.Varint
