<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU gawk 3.0.4

GCC 4.7.4 stage3 and musl 1.2.5 build a static gawk from the source of the
[early gawk](../gawk/README.md). The early Bison regenerates the parser, so
no release parser output is an input. Every source compiles under a stable
logical path with `-Werror`.

gawk runs commands through the shell in BOOTSTRAP_SHELL with the private
system and popen copies of [tools-final](../tools-final/README.md), which use
/bin/sh when it is unset and fail when it is empty. The runnable `:gawk`
target sets it to the final Bash. `:installation` holds gawk and awk, the bundled awk library
files, and musl's copyright for those shell functions.

## Tests

awk programs check fields and records, arrays and language features, math,
input and output pipelines with exit statuses, and the bundled library. gawk
must reject malformed programs and fail when BOOTSTRAP_SHELL is empty.

```
buck2 test cellar//bootstrap/stage1/gawk-final:
```
