<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# framelog

A record log of the kind a database writes ahead of its changes. Each
record is a frame:

    varint(length) ++ payload ++ crc32(payload), little-endian

A reader replays a log frame by frame. After a crash it keeps the frames
before the first one that is torn or damaged.

```console
$ buck2 run toolchains//lean/demo:framelog -- pack records.txt wal
4 records, 75 bytes
$ buck2 run toolchains//lean/demo:framelog -- unpack wal
begin transfer 42
debit alice 100
...
$ buck2 run toolchains//lean/demo:framelog -- recover damaged-wal wal
kept 1 records (22 bytes), dropped 53 bytes
```

It exists to use everything the Lean toolchain does, in the places a real
project would.

## What is where

| File | What it shows |
| --- | --- |
| `Framelog/Varint.lean` | LEB128 lengths, with proofs that decoding inverts encoding and that every number has exactly one encoding the decoder accepts |
| `Framelog/Crc32.lean` | CRC-32 twice: `spec`, the bit-by-bit definition, and `fast`, an `@[extern]` function in `crc32.c` |
| `Framelog/Crc32Check.lean` | `#guard`s that run the C code against `spec` while the library builds |
| `Framelog/Frame.lean` | the frame format, and `replay`: decoding a log of appended frames gives back exactly the records, in order |
| `Framelog.lean` | operations on whole logs, exported to C as `framelog_*` |
| `Main.lean` | the `framelog` program |
| `Golden.lean` | golden bytes, bit-flip and torn-write checks, and the theorems again, in a test of their own |
| `client.cpp` | a C++ program writing and scanning logs through the library |
| `fuzz.cpp` | a fozzie harness for the decoder |

## Proofs

`Frame.replay` is the property a log exists for:

```lean
theorem replay (records : List (List Nat)) (h : ∀ r ∈ records, ∀ b ∈ r, b < 256) :
    decodeAll (encodeAll records) = some records
```

It holds for any checksum function, so it covers the C code without
trusting it. `Crc32Check.lean` covers what the C code computes: the build
runs it against `Crc32.spec` on the standard check value and on 300
generated inputs. Change the polynomial in `crc32.c` and the library stops
building.

The proofs go the encoder's way: what is written reads back. The other
way, that any log the decoder accepts is exactly the encoding of its
records, is `Framelog.canonical`, which the fuzzer checks instead of a
proof. Planting a decoder that accepts a padded varint, `0x87 0x00` for 7,
makes `buck2 run toolchains//lean/demo:fuzz` abort within a few seconds
(about 80,000 inputs). The test's 2,000 runs only catch regressions that
show up quickly.

`:framelog-lib` sets `allow_sorry` false (the default), turns warnings into
errors and sets `autoImplicit` to false, so a proof cannot quietly go
missing. `:golden` replays its theorems through the kernel with
leanchecker.

## Toolchain features

- **Libraries, programs, tests.** `:framelog-lib`, `:framelog`, and `:golden`.
- **@[extern] in C.** `:crc32` depends on `toolchains//lean:headers` and
  implements `Crc32.fast`. It builds its table in a constructor, which runs
  in the program and again when lean loads the precompiled library.
- **Precompiled, module by module.** `Crc32Check` runs C code from
  `Crc32`, a module of the same target. The build loads `Crc32`'s own
  shared object and one holding `crc32.c` before elaborating it.
- **Precompiled, whole.** `Golden` is in another target, so it loads all
  of `:framelog-lib` as one shared object and runs the real `frame` and
  `scan` in its `#guard`s.
- **Packages.** `package = "framelog"` names the library's symbols,
  `initialize_framelog_Framelog` and the like, which `client.cpp` and
  `fuzz.cpp` call.
- **C++ calling Lean.** `:client` is a plain `cxx_binary` with
  `:framelog-lib` in its deps, run by `:client-test`.
- **Fuzzing.** `:fuzz` and `:fuzz-asan` instrument the Lean code along with
  the harness and link with lld. Their corpus starts from `:seed-log`, a
  log the program itself writes.
- **Editors.** Open any `.lean` file here with the repository's editor
  setup and the server builds its imports through Buck. Find-references on
  `Frame.encode` reaches `Framelog.lean` and `Golden.lean`.

## Running it

```console
$ buck2 test toolchains//lean/demo/...
$ buck2 run toolchains//lean/demo:fuzz          # keeps fuzzing until stopped
```

The codec works on `List Nat`, which keeps the proofs in plain arithmetic
and makes it slow on large logs. Fixing that means proving a `ByteArray`
implementation equal to this one, which the demo does not do.
