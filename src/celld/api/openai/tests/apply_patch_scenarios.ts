// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The portable apply-patch scenarios from openai/codex
 * (`codex-rs/apply-patch/tests/fixtures/scenarios`, Apache-2.0), as data:
 * each is an input tree, a patch, and the expected tree. Codex runs them in
 * its `PreserveLineEndings` mode, as this library applies patches.
 *
 * The scenario data is from OpenAI Codex, used under the Apache License,
 * Version 2.0. Its NOTICE reads: "OpenAI Codex / Copyright 2025 OpenAI".
 *
 * @module
 */

/** One scenario. */
export interface Scenario {
  readonly name: string;
  readonly input: Readonly<Record<string, string>>;
  readonly patch: string;
  readonly expected: Readonly<Record<string, string>>;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "001_add_file",
    input: {},
    patch:
      "*** Begin Patch\n*** Add File: bar.md\n+This is a new file\n*** End Patch\n",
    expected: {
      "bar.md": "This is a new file\n",
    },
  },
  {
    name: "002_multiple_operations",
    input: {
      "delete.txt": "obsolete\n",
      "modify.txt": "line1\nline2\n",
    },
    patch:
      "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Delete File: delete.txt\n*** Update File: modify.txt\n@@\n-line2\n+changed\n*** End Patch\n",
    expected: {
      "modify.txt": "line1\nchanged\n",
      "nested/new.txt": "created\n",
    },
  },
  {
    name: "003_multiple_chunks",
    input: {
      "multi.txt": "line1\nline2\nline3\nline4\n",
    },
    patch:
      "*** Begin Patch\n*** Update File: multi.txt\n@@\n-line2\n+changed2\n@@\n-line4\n+changed4\n*** End Patch\n",
    expected: {
      "multi.txt": "line1\nchanged2\nline3\nchanged4\n",
    },
  },
  {
    name: "004_move_to_new_directory",
    input: {
      "old/name.txt": "old content\n",
      "old/other.txt": "unrelated file\n",
    },
    patch:
      "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch\n",
    expected: {
      "old/other.txt": "unrelated file\n",
      "renamed/dir/name.txt": "new content\n",
    },
  },
  {
    name: "005_rejects_empty_patch",
    input: {
      "foo.txt": "stable\n",
    },
    patch: "*** Begin Patch\n*** End Patch\n",
    expected: {
      "foo.txt": "stable\n",
    },
  },
  {
    name: "006_rejects_missing_context",
    input: {
      "modify.txt": "line1\nline2\n",
    },
    patch:
      "*** Begin Patch\n*** Update File: modify.txt\n@@\n-missing\n+changed\n*** End Patch\n",
    expected: {
      "modify.txt": "line1\nline2\n",
    },
  },
  {
    name: "007_rejects_missing_file_delete",
    input: {
      "foo.txt": "stable\n",
    },
    patch: "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch\n",
    expected: {
      "foo.txt": "stable\n",
    },
  },
  {
    name: "008_rejects_empty_update_hunk",
    input: {
      "foo.txt": "stable\n",
    },
    patch: "*** Begin Patch\n*** Update File: foo.txt\n*** End Patch\n",
    expected: {
      "foo.txt": "stable\n",
    },
  },
  {
    name: "009_requires_existing_file_for_update",
    input: {
      "foo.txt": "stable\n",
    },
    patch:
      "*** Begin Patch\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch\n",
    expected: {
      "foo.txt": "stable\n",
    },
  },
  {
    name: "010_move_overwrites_existing_destination",
    input: {
      "old/name.txt": "from\n",
      "old/other.txt": "unrelated file\n",
      "renamed/dir/name.txt": "existing\n",
    },
    patch:
      "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-from\n+new\n*** End Patch\n",
    expected: {
      "old/other.txt": "unrelated file\n",
      "renamed/dir/name.txt": "new\n",
    },
  },
  {
    name: "011_add_overwrites_existing_file",
    input: {
      "duplicate.txt": "old content\n",
    },
    patch:
      "*** Begin Patch\n*** Add File: duplicate.txt\n+new content\n*** End Patch\n",
    expected: {
      "duplicate.txt": "new content\n",
    },
  },
  {
    name: "012_delete_directory_fails",
    input: {
      "dir/foo.txt": "stable\n",
    },
    patch: "*** Begin Patch\n*** Delete File: dir\n*** End Patch\n",
    expected: {
      "dir/foo.txt": "stable\n",
    },
  },
  {
    name: "013_rejects_invalid_hunk_header",
    input: {
      "foo.txt": "stable\n",
    },
    patch: "*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch\n",
    expected: {
      "foo.txt": "stable\n",
    },
  },
  {
    name: "014_update_file_appends_trailing_newline",
    input: {
      "no_newline.txt": "no newline at end\n",
    },
    patch:
      "*** Begin Patch\n*** Update File: no_newline.txt\n@@\n-no newline at end\n+first line\n+second line\n*** End Patch\n",
    expected: {
      "no_newline.txt": "first line\nsecond line\n",
    },
  },
  {
    name: "015_failure_after_partial_success_leaves_changes",
    input: {},
    patch:
      "*** Begin Patch\n*** Add File: created.txt\n+hello\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch\n",
    expected: {
      "created.txt": "hello\n",
    },
  },
  {
    name: "016_pure_addition_update_chunk",
    input: {
      "input.txt": "line1\nline2\n",
    },
    patch:
      "*** Begin Patch\n*** Update File: input.txt\n@@\n+added line 1\n+added line 2\n*** End Patch\n",
    expected: {
      "input.txt": "line1\nline2\nadded line 1\nadded line 2\n",
    },
  },
  {
    name: "017_whitespace_padded_hunk_header",
    input: {
      "foo.txt": "old\n",
    },
    patch:
      "*** Begin Patch\n  *** Update File: foo.txt\n@@\n-old\n+new\n*** End Patch\n",
    expected: {
      "foo.txt": "new\n",
    },
  },
  {
    name: "018_whitespace_padded_patch_markers",
    input: {
      "file.txt": "one\n",
    },
    patch:
      " *** Begin Patch\n*** Update File: file.txt\n@@\n-one\n+two\n*** End Patch \n",
    expected: {
      "file.txt": "two\n",
    },
  },
  {
    name: "019_unicode_simple",
    input: {
      "foo.txt": "line1\nnaïve café\nline3\n",
    },
    patch:
      "*** Begin Patch\n*** Update File: foo.txt\n@@\n line1\n-naïve café\n+naïve café ✅\n*** End Patch\n",
    expected: {
      "foo.txt": "line1\nnaïve café ✅\nline3\n",
    },
  },
  {
    name: "020_delete_file_success",
    input: {
      "keep.txt": "keep\n",
      "obsolete.txt": "obsolete\n",
    },
    patch: "*** Begin Patch\n*** Delete File: obsolete.txt\n*** End Patch\n",
    expected: {
      "keep.txt": "keep\n",
    },
  },
  {
    name: "020_whitespace_padded_patch_marker_lines",
    input: {
      "file.txt": "one\n",
    },
    patch:
      "*** Begin Patch \n*** Update File: file.txt\n@@\n-one\n+two\n *** End Patch\n",
    expected: {
      "file.txt": "two\n",
    },
  },
  {
    name: "021_update_file_deletion_only",
    input: {
      "lines.txt": "line1\nline2\nline3\n",
    },
    patch:
      "*** Begin Patch\n*** Update File: lines.txt\n@@\n line1\n-line2\n line3\n*** End Patch\n",
    expected: {
      "lines.txt": "line1\nline3\n",
    },
  },
  {
    name: "022_update_file_end_of_file_marker",
    input: {
      "tail.txt": "first\nsecond\n",
    },
    patch:
      "*** Begin Patch\n*** Update File: tail.txt\n@@\n first\n-second\n+second updated\n*** End of File\n*** End Patch\n",
    expected: {
      "tail.txt": "first\nsecond updated\n",
    },
  },
  {
    name: "023_preserves_crlf_line_endings",
    input: {
      "lines.txt": "one\r\ntwo\r\nthree\r\n",
    },
    patch:
      "*** Begin Patch\n*** Update File: lines.txt\n@@\n-one\n+ONE\n two\n+between\n three\n*** End Patch\n",
    expected: {
      "lines.txt": "ONE\r\ntwo\r\nbetween\r\nthree\r\n",
    },
  },
  {
    name: "024_preserves_mixed_line_endings",
    input: {
      "lines.txt": "one\r\ntwo\rthree\nfour\r\n",
    },
    patch:
      "*** Begin Patch\n*** Update File: lines.txt\n@@\n one\n two\n-three\n+THREE\n four\n*** End Patch\n",
    expected: {
      "lines.txt": "one\r\ntwo\rTHREE\r\nfour\r\n",
    },
  },
];
