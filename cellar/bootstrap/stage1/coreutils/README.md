<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU cat and rm

`musl:tcc` builds GNU `cat` and `rm` from coreutils 6.10 with the gnulib
helpers they use and a configuration header written in BUILD. binutils'
upstream linker-script generators need both commands. musl supplies the
descriptor-relative file operations and the stdio query that gnulib would
otherwise implement by reading `FILE` internals.

The `cat` tests cover binary data with repeated standard input, the `-A` and
`-s` display options, line numbering and write and option errors. The `rm`
test covers missing files with and without `-f`, a leading dash, interactive
answers, and recursive removal that refuses `.` and stays inside its tree.
Each test program writes `passed` into its declared output directory.

```
buck2 test cellar//bootstrap/stage1/coreutils: --local-only -j 8
```
