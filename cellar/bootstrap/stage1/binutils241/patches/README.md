<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Source changes

BUILD applies these exact replacements to the pinned binutils 2.41 source with
the bootstrapped immutable patch helper. Each must match exactly one block; no
fuzzy patching runs. Eight changes apply to 2.41 unchanged and come from the
[binutils 2.30 port](../../binutils/patches/README.md): the `i386-gen` input
directory and register table path, the three `gprof/i386.c` decoder fixes, and
the two linker emulation changes.

The helper's format leaves no room for a license header, so each patch has a
REUSE `.license` file beside it. Each before block retains its source file's
license, and each replacement is Copyright 2026 Austin Seipp under the same
license: LGPL-2.0-or-later for `tmpdir.patch` and GPL-3.0-or-later for the
others.

- `tmpdir.patch` makes a missing `TMPDIR` fatal in libiberty's temporary
  directory selection, instead of falling back to a host directory.
- `gen-no-chdir.patch` and `gen-opcodes-input.patch` keep `i386-gen` out of
  its `--srcdir` and read the preprocessed opcode table from that directory
  instead of standard input, so the generated tables go to the action's output
  directory.
- `gprof-native.patch` keeps only the x86 call decoder in `corefile.c`.
