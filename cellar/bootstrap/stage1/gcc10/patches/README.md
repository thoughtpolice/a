<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Source changes

GCC 10.5 already carries the musl target support that the GCC 4.7 port
patched in, so no live-bootstrap target patch is needed. BUILD applies these
exact replacements with the bootstrapped immutable patch helper. Each must
match exactly one block of the pinned source; no fuzzy patching runs.

Two of the GCC 4.7 port's [source changes](../../gcc47/patches/README.md)
apply unchanged and are read from there: `tmpdir.patch` makes a missing
`TMPDIR` fatal in libiberty's temporary directory selection, instead of
falling back to a host directory, and `gcov-program.patch` changes only the
generator-name comment in `gcov-iov.h` so that the header does not record an
action path.

The other replacements are written inline in BUILD. Their before blocks
retain GCC's GPL-3.0-or-later license (with the GCC Runtime Library Exception
for libgcc); the replacements are Copyright 2026 Austin Seipp under the same
terms.

- `makeucnid.c` stops before reading the entry one past its code-point tables
  in the final flush. The generated `ucnid.h` is unchanged.
- `genmatch.c` names its include directory `.` instead of the absolute
  working directory, which it would otherwise write into the comments of
  `gimple-match.c` and `generic-match.c`.
- `driver-tool.c` and `gcc.c` make a compiler, assembler or linker that the
  driver cannot find beside itself an error for ordinary commands and pipeline
  members, rather than a program to search for on the host `PATH`.
- `linux-unwind.h` enables the x86_64 signal-frame unwinder for musl as well
  as glibc. GCC 10 gates it on `__GLIBC__`; musl's `__restore_rt` is the same
  `rt_sigreturn` sequence the unwinder recognizes.
