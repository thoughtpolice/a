<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native binutils 2.30

This package builds the 15 native programs of binutils 2.30 with TCC and
musl 1.1.24: `as`, `ld`, `ar`, `ranlib`, `nm`, `objcopy`, `objdump`, `strip`,
`readelf`, `elfedit`, `addr2line`, `size`, `strings`, `c++filt` and `gprof`.
The first Bash, GNU cat and rm, sed, gawk, Flex and Bison run the generators.
No configure or Make process runs.

`binutils_stage` in [defs.bzl](defs.bzl) declares the graph. It composes
libiberty, zlib, BFD, opcodes, GAS, LD, gprof and the binutils commands from
the release files that [sources.bzl](sources.bzl) lists, with the
configuration headers in [config.bzl](config.bzl). Only the x86_64 ELF
backend and the generic formats it needs are built. The linker has no default
library search path, so callers pass their sysroot's libraries explicitly.

Every generated source is regenerated: the BFD headers written by chew, the
CRC table in libiberty, zlib's CRC, Huffman-tree and fixed-inflate tables,
the x86 opcode tables, the GAS flonum constants, the linker and ar grammars
and scanners, the linker emulation and scripts, and the gprof text tables.
The BFD headers and x86 tables match the release's copies byte for byte.
[patches](patches/README.md) describes the source changes.

The tests cover the regenerated sources, support libraries, object and
archive handling, disassembly, assembler execution and diagnostics, direct,
archive, partial and scripted links, debug data, symbol and section
transformations, deterministic archives, and gprof data and diagnostics.

```
buck2 test cellar//bootstrap/stage1/binutils:
```
