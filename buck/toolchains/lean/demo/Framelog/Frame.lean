-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

public import Framelog.Varint
public import Framelog.Crc32

/-!
# Frames

A log is frames back to back. A frame is a record and enough to find its
end and notice damage:

    varint(length) ++ payload ++ crc32(payload), little-endian

`decode_encode` says decoding gives back what was encoded, and `replay`
that reading a whole log gives back every record appended to it, in order.
Both hold whatever the checksum function computes, so they cover the C
implementation too; `Framelog.Crc32Check` covers what it computes.
-/

namespace Framelog.Frame

/-- The bytes of `x`, least significant first. -/
public def word (x : UInt32) : List Nat :=
  [x.toNat % 256, x.toNat / 256 % 256, x.toNat / 65536 % 256, x.toNat / 16777216 % 256]

/-- Reads a little-endian word off the front of `bytes`. -/
public def readWord : List Nat → Option (UInt32 × List Nat)
  | b0 :: b1 :: b2 :: b3 :: rest =>
    if b0 < 256 ∧ b1 < 256 ∧ b2 < 256 ∧ b3 < 256 then
      some ((b0 + 256 * b1 + 65536 * b2 + 16777216 * b3).toUInt32, rest)
    else none
  | _ => none

/-- `bytes` as the C side sees them. -/
public def toByteArray (bytes : List Nat) : ByteArray :=
  ByteArray.mk (bytes.map Nat.toUInt8).toArray

/-- The checksum stored in a frame. -/
public def checksum (payload : List Nat) : UInt32 :=
  Crc32.fast (toByteArray payload)

/-- The frame of `payload`. -/
public def encode (payload : List Nat) : List Nat :=
  Varint.encode payload.length ++ payload ++ word (checksum payload)

/-- Reads one frame off the front of `bytes`: its payload and what follows.
Fails on a short frame, a byte out of range or a checksum mismatch. -/
public def decode (bytes : List Nat) : Option (List Nat × List Nat) := do
  let (len, rest) ← Varint.decode bytes
  let payload := rest.take len
  if payload.length = len ∧ ∀ b ∈ payload, b < 256 then
    let (crc, rest') ← readWord (rest.drop len)
    if crc = checksum payload then some (payload, rest') else none
  else none

/-- Every frame in `bytes`, if all of it is frames. -/
public def decodeAll (bytes : List Nat) : Option (List (List Nat)) :=
  go bytes.length bytes
where
  go : Nat → List Nat → Option (List (List Nat))
    | _, [] => some []
    | 0, _ :: _ => none
    | fuel + 1, bytes@(_ :: _) =>
      match decode bytes with
      | some (payload, rest) => (payload :: ·) <$> go fuel rest
      | none => none

/-- A log of `records`, one frame each. -/
public def encodeAll (records : List (List Nat)) : List Nat :=
  records.flatMap encode

theorem readWord_word (x : UInt32) (rest : List Nat) :
    readWord (word x ++ rest) = some (x, rest) := by
  have hx := x.toNat_lt
  simp only [word, readWord, List.cons_append, List.nil_append]
  have h0 : x.toNat % 256 < 256 := by omega
  have h1 : x.toNat / 256 % 256 < 256 := by omega
  have h2 : x.toNat / 65536 % 256 < 256 := by omega
  have h3 : x.toNat / 16777216 % 256 < 256 := by omega
  simp only [h0, h1, h2, h3, and_self, ite_true, Option.some.injEq, Prod.mk.injEq, and_true]
  have : x.toNat % 256 + 256 * (x.toNat / 256 % 256) + 65536 * (x.toNat / 65536 % 256)
      + 16777216 * (x.toNat / 16777216 % 256) = x.toNat := by omega
  rw [this]
  exact UInt32.ofNat_toNat

/-- Decoding a frame gives back its payload and leaves the rest alone. -/
public theorem decode_encode (payload rest : List Nat) (h : ∀ b ∈ payload, b < 256) :
    decode (encode payload ++ rest) = some (payload, rest) := by
  simp only [encode, decode, List.append_assoc, Varint.decode_encode, Option.bind_eq_bind,
    Option.bind_some, List.take_left', List.drop_left', readWord_word]
  simpa using h

/-- A frame is never empty. -/
theorem encode_length (payload : List Nat) : 0 < (encode payload).length := by
  have := Varint.encode_ne_nil payload.length
  cases hv : Varint.encode payload.length with
  | nil => contradiction
  | cons => simp [encode, hv]

theorem go_encodeAll (records : List (List Nat)) (fuel : Nat)
    (hfuel : (encodeAll records).length ≤ fuel) (h : ∀ r ∈ records, ∀ b ∈ r, b < 256) :
    decodeAll.go fuel (encodeAll records) = some records := by
  induction records generalizing fuel with
  | nil => simp [encodeAll, decodeAll.go]
  | cons r rs ih =>
    have hr := encode_length r
    simp only [encodeAll, List.flatMap_cons] at hfuel ⊢
    simp only [List.length_append] at hfuel
    obtain ⟨fuel', rfl⟩ : ∃ f, fuel = f + 1 := ⟨fuel - 1, by omega⟩
    cases he : encode r with
    | nil => simp [he] at hr
    | cons b bs =>
      rw [List.cons_append, decodeAll.go, ← List.cons_append, ← he,
        decode_encode r _ (h r (by simp))]
      simp only [Option.map_eq_map, Option.map_eq_some_iff]
      exact ⟨rs, ih fuel' (by show (rs.flatMap encode).length ≤ fuel'; omega)
        (fun r' hr' => h r' (by simp [hr'])), rfl⟩

/-- Replaying a log gives back every record appended to it, in order. -/
public theorem replay (records : List (List Nat)) (h : ∀ r ∈ records, ∀ b ∈ r, b < 256) :
    decodeAll (encodeAll records) = some records :=
  go_encodeAll records _ (Nat.le_refl _) h

end Framelog.Frame
