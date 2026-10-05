-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

/-!
# CRC-32

The IEEE 802.3 checksum (reflected, polynomial `0xEDB88320`), as gzip, zip
and PNG use it. `spec` is the definition, one bit at a time. `fast` is the
table-driven version the program runs, written in C (`crc32.c`).
`Framelog.Crc32Check` holds the two to each other whenever the library
builds.
-/

namespace Framelog.Crc32

/-- One bit of the shift register. -/
def step (crc : UInt32) : UInt32 :=
  if crc &&& 1 == 1 then (crc >>> 1) ^^^ 0xEDB88320 else crc >>> 1

/-- One byte, eight bits. -/
def byte (crc : UInt32) (b : Nat) : UInt32 :=
  (List.replicate 8 ()).foldl (fun c _ => step c) (crc ^^^ b.toUInt32)

/-- The checksum of `data`, a list of bytes. -/
public def spec (data : List Nat) : UInt32 :=
  ~~~ (data.foldl byte 0xFFFFFFFF)

/-- The checksum of `data`, computed in C. -/
@[extern "framelog_crc32"]
public opaque fast (data : @& ByteArray) : UInt32

end Framelog.Crc32
