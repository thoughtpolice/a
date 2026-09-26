<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

The `full-names` blocks adapt GNU tar 1.12 `src/list.c` (Copyright 1988, 1992,
1993, 1994, 1996, 1997 Free Software Foundation, Inc.; GPL-2.0-or-later).
The replacement written by Austin Seipp in 2026 uses the same license. It copies
complete 100-byte name and link fields into terminated local buffers instead
of overwriting the final filename byte or reading beyond the link field.
The bootstrapped patch helper requires exactly one matching source block.

Each patch without its own SPDX notice has a REUSE `.license` file beside it
that records its copyright holders and license.
