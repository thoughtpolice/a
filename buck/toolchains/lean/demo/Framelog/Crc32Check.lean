-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

public import Framelog.Crc32
-- Runs Crc32.fast, which is C, while this module elaborates. Crc32 is in
-- the same target, so this takes per-module precompilation. The build
-- loads Crc32's shared object and one holding crc32.c first.
meta import Framelog.Crc32

/-!
# The C checksum against its definition

Nothing here is meant to be imported. Building it fails the build if
`crc32.c` ever disagrees with `Crc32.spec`.
-/

open Framelog.Crc32

/-- Bytes from a small linear congruential generator. -/
meta def sample (seed len : Nat) : List Nat :=
  (List.range len).map fun i => (seed * 1103515245 + i * 12345 + i * i * 7) % 256

meta def bytes (data : List Nat) : ByteArray :=
  ByteArray.mk (data.map Nat.toUInt8).toArray

-- The standard check value: CRC-32 of the ASCII digits 1 through 9.
#guard fast "123456789".toUTF8 == 0xCBF43926
#guard spec ("123456789".toUTF8.toList.map (·.toNat)) == 0xCBF43926
#guard fast ByteArray.empty == 0 && spec [] == 0

-- Every length up to 300, with some data to go with it.
#guard (List.range 300).all fun n => fast (bytes (sample n n)) == spec (sample n n)
