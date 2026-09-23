<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Final native binutils 2.30

This package rebuilds all 15 native programs with stage3 GCC 4.7.4 and musl
1.2.5. The toolchain installed them until [binutils 2.41](../binutils241/README.md)
replaced them; nothing depends on them now, and they are no longer part of the
final test gate. BUILD explicitly composes libiberty, zlib, BFD, opcodes, GAS,
LD, gprof and the native binutils commands. Its source pin, reviewed native
configuration and immutable adaptations follow the earlier binutils package.
That predecessor remains the assembler/linker used to build GCC, avoiding a
cycle through the final tools.

The final graph reruns every source generator: CRC/zlib tables, BFD headers,
x86 opcode tables, GAS flonum constants, Bison/Flex parsers and scanners,
linker emulation/scripts and gprof text tables. It uses final Bash, coreutils,
sed, gawk, Flex and Bison at their respective generator edges. No package-wide
configure or Make process runs. Native configurations retain only the selected
x86_64 ELF backend and the required generic formats.

Compilation uses `-O2 -Werror`, fixed time macros and stable logical source
paths. Local configuration headers precede other component headers. The BFD
object-reading test uses an ordinary function translation unit: optimized GCC
places a main-only generator in `.text.startup`, leaving `.text` empty.

All 48 tests pass. They cover regenerated tables, support libraries, native
object/archive handling, assembler execution and diagnostics, linking direct
objects/archives/partial links/custom scripts, debug data, symbol and section
transformations, deterministic archives and gprof data/diagnostics. All 15
installed executables are static ELF64/x86_64. Linker scripts and the upstream
GPL/LGPL license files are included in the installation.

```
buck2 test cellar//bootstrap/stage1/binutils-final: --local-only -j 8
```
