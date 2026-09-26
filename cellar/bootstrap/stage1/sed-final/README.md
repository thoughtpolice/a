<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU sed 4.0.9

GCC 4.7.4 stage3 and musl 1.2.5 build a static sed from the source of the
early sed. The native configuration enables the upstream multibyte regex and
replacement code, including multibyte transliteration, and musl supplies
getline, mkstemp and strverscmp.
A patch moves the setlocale call out of the message-catalog conditional, so
sed selects the locale with catalogs disabled.

sed's `e` command runs through BOOTSTRAP_SHELL, using the private popen copy
of [tools-final](../tools-final/README.md), and the runnable `:sed` target
sets it to the final Bash. `:installation` carries musl's copyright for that
function.

## Tests

sed scripts check UTF-8 matching and transliteration, backreferences, the
hold space, branches, long lines, input without a final newline, in-place
editing with backups and permissions, and shell execution. sed must reject a
malformed script and fail to run commands when BOOTSTRAP_SHELL is empty.

```
buck2 test cellar//bootstrap/stage1/sed-final:
```
