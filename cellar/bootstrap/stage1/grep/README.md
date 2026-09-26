<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU grep 2.4

GCC 4.7.4 stage3 and musl 1.2.5 build static grep, egrep and fgrep, each
linked from its own matcher selection and a shared archive of the upstream
DFA, GNU regex, keyword-set matcher and search code. BUILD declares a
reviewed LP64 configuration, and nothing is generated from the sources.

## Tests

The tests run each program over a fixed input for backreferences, extended
expressions, fixed strings, case folding, line numbers, multiple patterns and
context lines, and check the exit statuses for no match and for a malformed
pattern.

```
buck2 test cellar//bootstrap/stage1/grep:
```
