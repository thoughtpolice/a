<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Shell selection for the final userland

GCC 4.7.4 stage3 builds libshell.a, private copies of musl 1.2.5's `system`
and `popen` named `bootstrap_system` and `bootstrap_popen`. They keep musl's
signal and stream behavior but run the shell named by BOOTSTRAP_SHELL, fall
back to /bin/sh when it is unset, and fail with ENOENT when it is empty.
`system(NULL)` reports whether a shell is available. The final gawk, m4 and
sed link this library in place of musl's functions, so build actions can hand
them a declared Bash while ordinary callers keep the usual default.

## Tests

A C test checks exit statuses, signal dispositions and masks around
`system`, reading and writing through `popen`, a shell killed by a signal,
and that an empty BOOTSTRAP_SHELL makes both functions fail.

```
buck2 test cellar//bootstrap/stage1/tools-final:
```
