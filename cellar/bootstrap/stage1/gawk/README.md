<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU awk 3.0.4

Bison regenerates awk.y; the shipped awktab.c is excluded. Native TCC/musl
builds separate objects with bundled GNU regex, DFA and random-number routines.
Configuration selects native POSIX functions and TCC's alloca support, with
no package-wide build script. All C compilation uses -Werror.

The runnable `:gawk` carries the declared bootstrap Bash and upstream AWK
library directory. The private system/popen library and gawk's input-pipe path
require BOOTSTRAP_SHELL. The io.c adaptations are copyright 2026 Austin Seipp under
GPL-2.0-or-later; the prepared source retains all upstream notices.

Eight tests exercise record/field parsing, associative arrays and recursion,
regex substitution, numeric and bitwise functions, repeatable random seeds,
UTC date formatting, file I/O, shell pipes and status, AWK library lookup,
version, diagnostics and failure without a declared shell. This historical
version retains its byte-oriented string semantics.

```
buck2 test cellar//bootstrap/stage1/gawk: --local-only -j 8
```
