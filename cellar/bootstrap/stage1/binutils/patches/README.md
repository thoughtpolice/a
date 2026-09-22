<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Source changes

BUILD applies these exact replacements to the pinned binutils 2.30 source with
the bootstrapped immutable patch helper. Each must match exactly one block; no
fuzzy patching runs.

The helper's format leaves no room for a license header, so each patch has a
REUSE `.license` file beside it. Each before block retains its source file's
license, and each replacement is Copyright 2026 Austin Seipp under the same
license: LGPL-2.0-or-later for `tmpdir.patch`, BSD-3-Clause for the
`gprof/i386.c` changes, and GPL-3.0-or-later for the others.

- `tmpdir.patch` makes a missing `TMPDIR` fatal in libiberty's temporary
  directory selection, instead of falling back to a host directory.
- `gen-input-dir.patch`, `gen-local-dir.patch`, `gen-no-chdir.patch`,
  `gen-opcodes-path.patch` and `gen-registers-path.patch` keep `i386-gen`'s
  `--srcdir` as an input directory, reading the opcode and register tables
  from it without changing into it, so the generated tables go to the action's
  output directory.
- `ld-stringify.patch` and `ld-template-lines.patch` let the ELF emulation
  template find `astring.sed` beside it, and record template paths relative
  to the source directory in `#line` directives.
- `gprof-native.patch` keeps only the x86 call decoder in `corefile.c`.
  `gprof-bounds.patch` stops that decoder where fewer than five bytes of text
  remain, `gprof-displacement.patch` sign-extends a call's 32-bit
  displacement, and `gprof-next-call.patch` skips the rest of each call
  instruction it finds.
