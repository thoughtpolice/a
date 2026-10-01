<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted from Anthropic playground/templates/document-critique.md, Apache-2.0, ab024cdc. Modified: exact line ranges, safe text rendering, explicit decisions and accessible export. -->
# Document critique

Use for specs, proposals, READMEs, skills, or documentation feedback. Read
[the core workflow](../SKILL.md). Show the full numbered document next to a
filterable suggestions list and counts; keep prompt export below.

## Input and state

Read the actual document. Preserve its text and line numbering. Each suggestion
has a stable ID, exact `startLine`/`endLine` (inclusive, 1-based), target quote,
actionable suggestion, category (clarity/completeness/performance/accessibility/UX),
`pending | approved | rejected`, and `userComment`. Keep decisions/comments, active
filter, and active suggestion in one state; do not mutate source text in this UI.

Validate ranges against document length. Match explicit ranges and target text;
if the source changed and no exact match exists, flag a stale suggestion instead
of quietly anchoring it within ±2 lines. Multiple suggestions may share a range.
Click/keyboard-select a card to scroll to its first line and mark the associated
range. Show status in text/icons as well as amber/green/red borders; rejected text
must remain legible. Make line navigation and cards keyboard reachable.

Provide Approve, Reject, Comment, Reset decisions and All/Pending/Approved/Rejected
filters. Counts reflect all suggestions, not only the current filter. Draft comment
text survives rerendering; save/cancel distinguishes persistent feedback from a
draft. Use `textContent` for plain text or a deliberately small Markdown renderer
that escapes source before adding headings/code/emphasis; never pass raw document
HTML through. Preserve fenced code and literal line content.

Use 3–5 useful view presets (all feedback, unresolved, accepted edits, category
focus) rather than presets that approve everything on the user's behalf. An explicit
reset can clear decisions/comments, with a clear label so it isn't mistaken for
resetting the current filter.

## Export and proof

Generate a request for the named document containing approved improvements and
additional user comments, grouped by exact line ranges/quotes. Include rejected
suggestions only as labeled context (“do not apply”), never as approved edits.
Uncommented pending suggestions are not instructions. If nothing is actionable,
explain how to approve/comment; do not emit a misleading empty update request.

Verify overlapping ranges, first/last line, stale target, approval→rejection→reset,
filters/counts, edited comment→cancel, denied copy, hostile Markdown/HTML, and that
only approved edits or explicit comments become requested changes.
