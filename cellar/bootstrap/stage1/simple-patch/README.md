<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Exact source replacements

`simple-patch` applies the bootstrap's source patches. It comes from
the MIT-licensed helper in the pinned live-bootstrap reference, and
M2-Mesoplanet builds it, so it exists before any general patch program. It
replaces exactly one occurrence of a nonempty byte string and writes the
result to a new file. It fails when the string is absent or occurs more than
once.

```text
simple-patch input change.patch output
```

A change is a `.patch` file with two file headers and one unified hunk.
Context, removed and added lines carry the usual space, `-` and `+`
prefixes, and `\ No newline at end of file` marks a block that ends without
a newline. The hunk's coordinates describe the old and new blocks
themselves. Each starts at line 1, or 0 when empty, and the line counts must
match the contents. The header filenames are only descriptive.
The old block matches anywhere in the input, even inside a line. Multiple
hunks, offsets, fuzzy matching and malformed newline markers are errors.

BUILD applies a change with `exact_patch`, from a `.patch` file or from
short `before` and `after` strings, which the rule writes as the same
one-hunk patch. Template substitutions that may occur many times use
mescc-tools-extra's `replace` through the `replace` rule instead.

The tests cover whole and partial lines, context lines, either side without
a final newline, deletion, absent and repeated matches, oversized patterns,
malformed hunks and an output that is also the input. Invalid patches fail
before the output is opened.
