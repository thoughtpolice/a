<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Source changes

GCC 13.5 carries the musl target support the GCC 4.7 port patched in, so no
live-bootstrap target patch is needed. BUILD applies these exact replacements
with the bootstrapped immutable patch helper. Each must match exactly one
block of the pinned source; no fuzzy patching runs.

`tmpdir.patch` adapts libiberty's LGPL-2.0-or-later temporary directory
selection so that a missing `TMPDIR` is fatal instead of falling back to a
host directory. It is the GCC 10 port's change, rebased because GCC 13 no
longer tries `/usr/tmp`. The original source copyright is retained, and the
replacement written by Austin Seipp in 2026 is licensed under
LGPL-2.0-or-later. The patch format has no room for a license header, so
`tmpdir.patch.license` records these terms in REUSE form.

The remaining replacements are written inline in BUILD. Their before blocks
retain GCC's GPL-3.0-or-later license (with the GCC Runtime Library Exception
for libgcc); the replacements are Copyright 2026 Austin Seipp under the same
terms.

- `makeucnid.cc` stops before reading the entry one past its code-point
  tables in the final flush. The generated `ucnid.h` is unchanged.
- `makeuname2c.cc` sorts its radix-tree nodes with `std::stable_sort` instead
  of `qsort`. Nodes with equal keys compare equal; the shipped `uname2c.h`
  keeps them in insertion order, as glibc's merge sort does, and musl's
  `qsort` orders them differently.
- `genmatch.cc` names its include directory `.` instead of the absolute
  working directory, which it would otherwise write into the comments of
  `gimple-match.cc` and `generic-match.cc`.
- `gcc.cc` makes a compiler, assembler or linker that the driver cannot find
  beside itself an error for ordinary commands and pipeline members, rather
  than a program to search for on the host `PATH`.
- `linux-unwind.h` enables the x86_64 signal-frame unwinder for musl as well
  as glibc. GCC 13 still gates it on `__GLIBC__`; musl's `__restore_rt` is
  the same `rt_sigreturn` sequence the unwinder recognizes.

The GCC 10 port's `gcov-iov` change is gone: GCC 13 writes the gcov version
into `version.h` with `genversion`, which records no path.
