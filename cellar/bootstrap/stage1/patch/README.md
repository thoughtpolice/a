<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GNU patch 2.5.9

GCC 4.7.4 stage3 and musl 1.2.5 build a static patch with a reviewed native
configuration for files, signals, wide characters and unlocked stdio. It
applies unified, context and normal diffs, reverses them, writes backups and
reject files, and parses dates. Ed-format diffs still need an external ed, as
upstream does.

## Tests

The integration test makes diffs with the final GNU diff and applies them
forward and in reverse in all three formats. It checks rejected hunks, that a
rejected input stays unchanged, and malformed diffs, with temporary files
inside the action's output directory.

```
buck2 test cellar//bootstrap/stage1/patch:
```
