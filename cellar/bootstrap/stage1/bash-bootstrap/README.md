<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native generator shell

`musl:tcc` builds Bash 2.05b. BUILD declares the Linux x86_64 configuration
and all source, library and generator stages:

- oyacc regenerates `y.tab.c` and `y.tab.h` from `parse.y`;
- upstream `mkbuiltins` generates builtin implementations, declarations and table;
- upstream `mksyntax` and `mksignames` regenerate their tables;
- version constants and declarations are explicit, stable configuration values.

The prepared source excludes the shipped generated parser, builtin and table files.
Native job control, arrays, arithmetic and multibyte patterns are enabled.
Readline, history and loadable builtins are outside this generator shell's
role. Bash 2.05b keeps its historical byte-oriented parameter lengths and
substrings and its first-line binary-script check.

The source adaptation gives this bootstrap shell a fixed user identity and its
own executable as the default shell, avoiding an implicit executor `/etc/passwd`
read. Here-documents honor TMPDIR, and their test runs inside a declared output
directory. A missing `zcatfd` prototype is supplied. These adaptations are under the
upstream GPL-2.0-or-later license; source notices and COPYING are preserved.
The default utility path is `/bootstrap/bin`; generator actions must supply their
actual bootstrapped tool directory. They do not discover host tools via PATH.

All C objects compile with warnings treated as errors. The tests cover parser
and builtin behavior, pipelines and redirection, traps, background jobs and
wait, wide patterns, syntax errors, and rejection of an undeclared command.
Generator calls pass `--noprofile --norc`, and the cellar rules clear their
action environments.

```
buck2 test cellar//bootstrap/stage1/bash-bootstrap: --local-only -j 8
```
