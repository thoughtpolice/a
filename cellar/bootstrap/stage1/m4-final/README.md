<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU m4 1.4.7

GCC 4.7.4 stage3 and musl 1.2.5 build a static m4 from the source of the
[early m4](../m4/README.md), with the macro engine and the GNU helper archive
declared separately. m4 runs shell commands through BOOTSTRAP_SHELL, using
the private system and popen copies of [tools-final](../tools-final/README.md),
and the runnable `:m4` target sets it to the final Bash. Its temporary-file
helper honors TMPDIR, rejects an empty value and falls back to /tmp when
TMPDIR is unset. `:installation` carries musl's copyright for the shell and
temporary-file functions.

## Tests

m4 input files check nested macros, includes and diversions, freezing and
reloading state, shell capture and exit statuses, and a diversion larger than
m4's 512 KiB memory limit, which forces the temporary-file path. m4 must reject
malformed input and an empty TMPDIR, and its shell commands must fail when
BOOTSTRAP_SHELL is empty.

```
buck2 test cellar//bootstrap/stage1/m4-final:
```
