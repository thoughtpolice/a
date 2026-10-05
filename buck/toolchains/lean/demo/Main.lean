-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

import Framelog

/-!
# framelog

    framelog pack RECORDS LOG      one frame per line of RECORDS
    framelog unpack LOG            print every record, or fail if LOG is damaged
    framelog recover LOG OUT       copy the intact frames at the start of LOG
-/

open Framelog

def usage : IO UInt32 := do
  IO.eprintln "usage: framelog pack RECORDS LOG | unpack LOG | recover LOG OUT"
  return 2

def pack (input output : String) : IO UInt32 := do
  let lines := (← IO.FS.readFile input).splitOn "\n"
  let lines := if lines.getLast? == some "" then lines.dropLast else lines
  let log := lines.foldl (fun log line => log ++ frame line.toUTF8) ByteArray.empty
  IO.FS.writeBinFile output log
  IO.eprintln s!"{lines.length} records, {log.size} bytes"
  return 0

def unpack (input : String) : IO UInt32 := do
  match records (← IO.FS.readBinFile input) with
  | some rs =>
    for r in rs do
      IO.println (String.fromUTF8? r |>.getD s!"<{r.size} bytes>")
    return 0
  | none =>
    IO.eprintln s!"{input}: damaged; try framelog recover"
    return 1

def recover (input output : String) : IO UInt32 := do
  let log ← IO.FS.readBinFile input
  let (count, used) := scan log
  IO.FS.writeBinFile output (log.extract 0 used)
  if used == log.size then
    IO.eprintln s!"{count} records, nothing to recover"
  else
    IO.eprintln s!"kept {count} records ({used} bytes), dropped {log.size - used} bytes"
  return 0

def main : List String → IO UInt32
  | ["pack", input, output] => pack input output
  | ["unpack", input] => unpack input
  | ["recover", input, output] => recover input output
  | _ => usage
