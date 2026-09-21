<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Heirloom lex

The pinned 070527 source contains a handwritten lexer and a yacc grammar.
Oyacc regenerates the parser; native TCC/musl builds lex and all normal `libl.a`
variants. The CDDL, Caldera and Berkeley license files and source notices remain
in the prepared source tree.

The runnable `:lex` target carries `-Y` and the declared skeleton directory in
RunInfo. Its underlying executable has no host skeleton search path. The scanner
test exercises longest matches, exclusive comment states, numbers, whitespace,
and fallback characters, then compiles and executes the generated C.

```
buck2 test cellar//bootstrap/stage1/heirloom-lex: --local-only
```
