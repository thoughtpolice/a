<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU sed 4.0.9

`tcc-release:tcc-mes1`, the release TCC linked against Mes libc, builds GNU
sed 4.0.9 against the `runtime-mes1` sysroot, one translation unit at a time,
with its bundled GNU regex and a configuration header written in BUILD. No
configure or Make step runs. Sed then generates musl's `alltypes.h` and
`syscall.h`. It works in the C locale, without multibyte conversion or
message catalogs.

The tests cover backreferences, the hold space, branching, a line longer than
8 KiB, input without a final newline, and rejection of a malformed script.

```
buck2 test cellar//bootstrap/stage1/sed: --local-only -j 8
```
