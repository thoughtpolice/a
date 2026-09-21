<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# musl character tables

The source archive pins musl-chartable-tools at
`44d780e03e78efcb3168ceab068170206dc92e85`, as in the principal live-bootstrap
reference. Its raw Unicode and encoding data retain the upstream notices.
The table generators run under the corrective, self-hosted musl-linked TCC
(`tcc-musl:musl2`). Their only source adaptation makes successful returns from
`main` explicit for this TCC.

BUILD declares the upstream C generators and every data input. `table-order.c`
implements the original Makefile's two filtering/sorting transformations for
`legacychars.h` and `revjis.h`; it does not build packages or invoke other tools.
The original `mkcodepage.c` consumes the regenerated legacy table. Its outputs
are concatenated in `aliases.txt` order with stage0 `catm`.

All twelve outputs are compared by value against the musl 1.1.24 release tables.
These published tables are test inputs only. No generator or delivered library
consumes them. The comparison handles numeric arrays and octal-escaped string
tables independently of whitespace and line wrapping.

`gen_casemap.c` is an unfinished diagnostic program, not an input to musl's
published table generation. The restored `towctrans.c` uses musl's maintained
source macros and the regenerated classification tables.

```
buck2 test cellar//bootstrap/stage1/musl-tables: --local-only -j 8
```
