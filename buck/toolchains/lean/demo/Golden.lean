-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

public import Framelog
-- Runs the library while this module elaborates. Framing calls Crc32.fast,
-- which is C. Framelog is in another target, so the build loads the
-- precompiled :framelog-lib whole.
meta import Framelog

/-!
# Golden values and the theorems, checked again

The `#guard`s fail the build if the format changes. The theorems restate
what `Framelog.Frame` proves, and the test replays them through the
kernel with leanchecker.
-/

open Framelog Framelog.Frame

-- The frame of "hello": its length, its bytes, and the CRC-32 that
-- zlib.crc32(b"hello") gives (0x3610A686), least significant byte first.
#guard (frame "hello".toUTF8).toList.map (·.toNat)
  == [5, 104, 101, 108, 108, 111, 0x86, 0xA6, 0x10, 0x36]

-- A record of 300 bytes takes a two-byte length.
#guard ((frame (ByteArray.mk (Array.replicate 300 0))).toList.take 2).map (·.toNat) == [0xAC, 0x02]

meta def sampleLog : ByteArray :=
  ["begin 7", "put account/alice 100", "put account/bob 250", "commit 7"].foldl
    (fun log r => log ++ frame r.toUTF8) ByteArray.empty

#guard (records sampleLog).map (·.map fun r => String.fromUTF8! r)
  == some ["begin 7", "put account/alice 100", "put account/bob 250", "commit 7"]

-- Flipping any one bit of any byte of the log is detected.
#guard (List.range sampleLog.size).all fun i =>
  (List.range 8).all fun bit =>
    (records (sampleLog.set! i (sampleLog.get! i ^^^ (1 <<< bit.toUInt8)))).isNone

-- A write torn anywhere keeps exactly the frames before the tear.
#guard (List.range sampleLog.size).all fun n =>
  let (count, used) := scan (sampleLog.extract 0 n)
  (records (sampleLog.extract 0 used)).map List.length == some count

/-- Whatever is appended to a log comes back out of it, in order. -/
theorem log_roundtrip (rs : List (List Nat)) (h : ∀ r ∈ rs, ∀ b ∈ r, b < 256) :
    decodeAll (encodeAll rs) = some rs :=
  replay rs h

/-- A frame read off the front of a log leaves the rest of the log as it was. -/
theorem frame_then_rest (payload rest : List Nat) (h : ∀ b ∈ payload, b < 256) :
    decode (encode payload ++ rest) = some (payload, rest) :=
  decode_encode payload rest h

/-- Varints mean the same number they were written as. -/
theorem varint_roundtrip (n : Nat) : Varint.decode (Varint.encode n) = some (n, []) := by
  simpa using Varint.decode_encode n []
