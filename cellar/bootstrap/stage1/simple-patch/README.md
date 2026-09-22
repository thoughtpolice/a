<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Exact source replacements

The MIT-licensed helper comes from the pinned live-bootstrap reference and is
built by M2-Mesoplanet. It runs before a general-purpose patch utility exists.
It writes a separate output and requires exactly one occurrence of a nonempty
original byte string. It never guesses which occurrence to replace.

Each source change is stored in one `.patch` file containing two file headers
and one unified hunk. Context, removed, and added lines use the usual space,
`-`, and `+` prefixes. `\ No newline at end of file` preserves a block that
ends without a newline. The hunk's line counts must match its contents.
The headers' filenames are descriptive; the input and output are explicit
command arguments:

```text
simple-patch input change.patch output
```

This is a strict replacement format, not a general GNU patch implementation.
Hunk coordinates describe the complete old and new blocks: their first line
is 1, or 0 for an empty block. The original block is found by exact byte matching
anywhere in the input, including within a line. Multiple hunks, offset-based
application, fuzzy matching, and malformed newline markers are rejected.

BUILD declares the input, patch, and output through `exact_patch`. A small
replacement can instead specify `before` and `after` strings there; the rule
writes the single patch artifact with Buck's built-in `actions.write` API.
It invokes the same M2-built helper as a declared execution dependency.
No paired fragment files, host patch tool, or mutable source tree is needed.

The tests cover whole and partial lines, context lines, either side without a
final newline, deletion, duplicate or absent matches, oversized patterns, and
malformed hunks. Invalid patches fail before the output is opened.
