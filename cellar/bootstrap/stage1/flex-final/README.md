<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Final Flex 2.6.4

The final static scanner generator and libfl are compiled with stage3 GCC 4.7.4
and musl 1.2.5. The pinned source and exact m4 adaptation are shared with the
earlier Flex package. BUILD declares every translation unit and generator.

Oyacc regenerates the grammar parser. Upstream mkskel.sh runs with final Bash,
sed and m4. The earlier source-bootstrapped Flex generates the first scanner;
the final executable regenerates it and reproduces the result byte-for-byte.
Release-generated scanners, parsers and skeleton C files are not build inputs.
Compiler source paths and scanner input spellings are stable across workspaces.

Eleven tests cover scanner regeneration, compressed/full/fast tables, eight-bit
input, exclusive states, reentrancy, libfl, malformed grammars, missing m4,
external tables and generated headers. A C++ scanner is compiled with final
G++/libstdc++ and checks stream input and tokenization. All compilation uses
`-Werror`. The installation contains flex, libfl.a, FlexLexer.h and COPYING.

```
buck2 test cellar//bootstrap/stage1/flex-final: --local-only -j 8
```
