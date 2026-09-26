<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Source changes

GCC 13.5 carries the musl target support the GCC 4.7 port patched in, so no
live-bootstrap target patch is needed. The shared
[GCC port](../../gcc/README.md) applies the changes every release needs.
This release adds two.

`tmpdir.patch` adapts libiberty's LGPL-2.0-or-later temporary directory
selection so that a missing `TMPDIR` is fatal instead of falling back to a
host directory. It is the GCC 4.7 port's change, which GCC 10 applies
unchanged, rebased because GCC 13 no longer tries `/usr/tmp`. The original
source copyright is retained, and the replacement written by Austin Seipp in
2026 is licensed under LGPL-2.0-or-later. The patch format has no room for a
license header, so `tmpdir.patch.license` records these terms in REUSE form.

BUILD writes the other change inline. Its before blocks retain GCC's
GPL-3.0-or-later license; the replacement is Copyright 2026 Austin Seipp
under the same terms. `makeuname2c.cc` sorts its radix-tree nodes with
`std::stable_sort` instead of `qsort`. Nodes with equal keys compare equal;
the shipped `uname2c.h` keeps them in insertion order, as glibc's merge sort
does, and musl's `qsort` orders them differently.
