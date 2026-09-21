<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native generator shell

Bash 2.05b uses the source-regenerated musl 1.1.24 sysroot. BUILD declares the
reviewed Linux/AMD64 configuration and all source, library and generator stages:

- oyacc regenerates `y.tab.c` and `y.tab.h` from `parse.y`;
- upstream `mkbuiltins` generates builtin implementations, declarations and table;
- upstream `mksyntax` and `mksignames` regenerate their tables;
- version constants and declarations are explicit, stable configuration values.

The prepared source excludes the shipped generated parser/builtin/table files.
Native job control, arrays, arithmetic and multibyte patterns are enabled;
readline, history and loadable builtins are outside this generator shell's role.
The eventual delivered shell remains Bash 5.2.15. Bash 2.05b retains its historical
byte-oriented parameter length/substrings and first-line binary-script check.

The source adaptation gives this bootstrap shell a fixed user identity and its
own executable as the default shell, avoiding an implicit executor `/etc/passwd`
read. Here-documents honor TMPDIR, and their test runs inside a declared output
directory. A missing `zcatfd` prototype is supplied. These adaptations are under the
upstream GPL-2.0-or-later license; source notices and COPYING are preserved.
The default utility path is `/bootstrap/bin`; generator actions must supply their
actual bootstrapped tool directory. They do not discover host tools via PATH.

All C objects compile with warnings treated as errors. Seven tests cover parser
and builtin behavior, pipelines/redirection, traps/background jobs/wait, wide
patterns, syntax errors, and rejection of an undeclared command. A native startup
trace with an empty environment confirmed no successful external file opens.
Use `--noprofile --norc` for generator calls; generator action environments are
cleared by the cellar-local rule.

```
buck2 test cellar//bootstrap/stage1/bash-bootstrap: --local-only -j 8
```
