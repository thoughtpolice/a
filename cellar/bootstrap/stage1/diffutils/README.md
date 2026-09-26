<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU diffutils 2.7

GCC 4.7.4 stage3 and musl 1.2.5 build static diff, cmp, diff3 and sdiff with
the bundled GNU regex and fnmatch. The native configuration enables fork,
signals and the standard POSIX file interfaces.

[patches/README.md](patches/README.md) describes the patches. diff3 and sdiff
find diff through PATH instead of a compiled installation prefix, and diff
finds pr the same way. The runnable `:diff3` and `:sdiff` targets put only the
package's diff on PATH. The regex patches keep pointers at full width on LP64
in the failure stack and in saved-position comparisons.

## Tests

The integration test checks unified diffs, binary and status comparisons,
ignored changes, including nested and alternating regex patterns that
backtrack, three-way merges and interactive sdiff selection. diff3 must fail
when PATH holds no diff.

```
buck2 test cellar//bootstrap/stage1/diffutils:
```
