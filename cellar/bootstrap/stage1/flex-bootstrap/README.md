<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Flex 2.5.11

The pinned source revision is d160f0247ba1611aa59d28f027d6292ba24abb50.
Oyacc regenerates parse.c/parse.h. Heirloom lex consumes live-bootstrap's
handwritten scan.lex.l to build the first Flex executable; that executable
regenerates the upstream scan.l. The completed Flex reproduces the scanner
byte-for-byte with line directives disabled.

The upstream mkskel.sh generator runs under bootstrap Bash with declared sed.
Its two here-document copies use shell builtins. No release-generated parser,
scanner or skeleton C file is consumed. Source adaptations and attribution are
documented in patches/README.md.

Eight tests cover scanner regeneration, compressed/full/fast tables, exclusive
states and eight-bit input, independent reentrant scanners with line counters
and unput, libfl's main/yywrap, version, and malformed-input diagnostics.
All compiled sources, including generated scanners, use -Werror.

```
buck2 test cellar//bootstrap/stage1/flex-bootstrap: --local-only -j 8
```
