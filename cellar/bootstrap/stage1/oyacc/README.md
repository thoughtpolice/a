<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Handwritten yacc seed

Oyacc 6.6 is built from its handwritten C sources using the source-regenerated
musl sysroot and native TCC. The reviewed configuration uses musl's asprintf,
strlcpy and program name, plus oyacc's reallocarray implementation. The temporary
file patch honors TMPDIR so generator actions write only inside their declared
output directory. Source files retain their BSD and public-domain notices.

The four tests run an oyacc-generated parser: precedence, parentheses, 64-bit
semantic values and malformed input. No release-generated parser is consumed.

```
buck2 test cellar//bootstrap/stage1/oyacc: --local-only
```
