<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native binutils 2.41

binutils 2.41 is the version live-bootstrap builds after GCC 10.5.0. This
package builds its 15 native programs with the final GCC 10.5 and musl 1.2.5,
using the final Bash, coreutils, diffutils, sed, gawk, Flex and Bison at the
generator edges. The graph follows the earlier binutils 2.30 packages:
`defs.bzl` explicitly composes libiberty, zlib, BFD, opcodes, GAS, LD, gprof and
the binutils commands, and retains only the x86_64 ELF backend and the required
generic formats. No configure or Make process runs.

Every source generator runs again, and each regenerated file matches the
release copy byte for byte: the BFD headers written by chew, zlib's CRC,
Huffman-tree and fixed-inflate tables, and the x86 instruction, initializer
and mnemonic tables. The CRC table in libiberty, the GAS flonum constants,
the linker grammar, scanner, emulation and scripts, the ar grammar and
scanner, and the gprof text tables are regenerated as in 2.30.

Differences from 2.30:

- libbfd now reads and writes SFrame sections through libsframe, so every
  program linking BFD also links it. libsframe includes one header from libctf;
  libctf itself is not built, as with `--disable-libctf`.
- The x86 opcode table is C-preprocessed before `i386-gen` reads it. GCC 10's
  preprocessor writes it to a file, and a patch makes `i386-gen` read that file
  instead of standard input. GAS compiles the tables into `tc-i386` and no
  longer links libopcodes.
- zlib 1.2.12's `crc32.c` writes `crc32.h` from its own `main`, so that table
  has its own small generator.
- The linker's emulation templates now compare generated scripts with `cmp`.

The configuration follows configure's defaults for x86_64 Linux: GAS marks
objects with the x86 ISA note and compresses debug sections, and the linker
emits both hash styles, uses separate code segments and RELRO, and warns about
executable stacks and RWX segments. Unlike configure's default, the linker also
compresses debug sections, as with `--enable-compressed-debug-sections=all`.
Archives are deterministic by default.
Separate debug files and the default sysroot point at nonexistent directories.

All 52 tests pass. They cover the regenerated sources, support libraries,
object and archive handling, disassembly, assembler execution and diagnostics,
direct, archive, partial and scripted links, debug data, symbol and section
transformations, deterministic archives, and gprof data and diagnostics. All
but the BFD and opcodes test programs, and eight of the source changes, are
shared with the 2.30 port; see [patches](patches/README.md).

```
buck2 test cellar//bootstrap/stage1/binutils241:
```
