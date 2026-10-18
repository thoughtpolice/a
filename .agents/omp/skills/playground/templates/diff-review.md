<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted from Anthropic playground/templates/diff-review.md, Apache-2.0, ab024cdc. Modified: native read-only source acquisition, stable side-specific references, safe accessible feedback export. -->
# Diff review

Use for commit/PR diffs, before/after refactoring, conflict comparison, or audits.
Read [the core workflow](../SKILL.md). Show source metadata and file/hunk navigation
beside a locally scrolling diff; place export below without covering source lines.

## Acquire and model

Use native repository/PR read tools for the actual diff and metadata. Do not mutate
Git, post comments, or fetch extra private content just to fill the UI. Preserve
file names, hunk headers, context, additions, deletions, renames, binary-file notices,
and no-newline markers; label unsupported combined/conflict diff formats explicitly.

Model each file with stable identity, hunks with old/new start/count, and lines
`{id,type,oldNum,newNum,content}`. Count old numbers for context/deletion and new
numbers for context/addition. Comment keys include file + hunk + side + line,
not displayed row index alone; renames and multiple hunks must not collide. A
comment on a deletion references the old side, never an invented new line number.

Render escaped text, prefix (`+`, `-`, space), both line numbers, and optional safe
syntax-token spans. Use green/red backgrounds with textual signs; hunk headers
remain distinct. Keep unbroken code scroll inside the diff container. A focusable
line action opens its textarea with Save/Cancel; saved comments show an indicator
and can be edited or removed. Save empty text removes the comment. Cancel restores
the saved value. Keep active line, draft, filters, and saved comments in one state.

Provide 3–5 view presets (all files, changed lines, file focus, commented lines,
security-sensitive paths when grounded in source). Presets never rewrite comments.
Keep a reset-view action distinct from explicit clear-feedback. Include hover and
keyboard hints, a comment count, and truthful copy success/failure feedback.

## Export and proof

Export only saved user comments, in source order: project/commit/PR identity,
file, old/new side and line, quoted code, comment. The request should be usable
without the page. No saved comments means instructional empty state, not an empty
“review comments” request. Raw source/comment text is data, not executable HTML.

Verify context/add/delete numbering, multi-hunk references, renamed files, empty
save removal, edit/cancel, view preset preservation, keyboard selection, hostile
code/comments, and export references matching the actual selected lines. Copying
feedback does not authorize posting it to a PR.
