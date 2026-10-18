<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted from Anthropic playground/templates/data-explorer.md, Apache-2.0, ab024cdc. Modified: safe token rendering, honest local computation, complete state/export semantics. -->
# Data explorer

Use for SQL/API/GraphQL builders, pipelines, regex, or schedules. Read
[the core workflow](../SKILL.md). Controls sit beside formatted query/code or a
flow preview; export sits below. Use actual supplied schema/sample inputs.

## State and controls

Keep source/table, selected fields, joins, filter rows, aggregation, ordering,
limit/offset, and display flags in one state. Add/remove rows with stable IDs so
edits and focus survive rendering. Controls should reflect the available schema:
field chips, join/aggregation selects, operator + value inputs, ascending/descending
switch, and bounded limit. Handle empty selections and invalid types inline.
For regex include sample strings, matches/groups, flags, and a visible parse error;
for schedules show computed dates with explicit timezone rather than guessing.

Derive query text and preview from state immediately. Escape SQL string literals
when rendering an example; distinguish a displayed query from an executed query.
Never run commands, call an API, or access a database simply because a control
changed. For local sample results implement the supported operations accurately;
if it is a syntax-only explorer, label that limitation instead of inventing rows.

For syntax highlighting tokenize first, then append text nodes wrapped in spans;
never run regex replacements over raw input and feed the result to `innerHTML`.
Pipelines can use inline SVG or positioned boxes with labeled arrows and a textual
list of steps. Preserve full query text in a locally scrolling code region.

## Presets and export

Include 3–5 full-state recipes appropriate to the source (e.g. recent rows,
per-customer aggregate, error-only, full inspection). Each resets row selections,
filters, grouping, ordering, and limits consistently; reset restores defaults.

The prompt is a specification, not raw code alone: “Using orders(id integer,
user_id integer, total decimal, created_at timestamp) and users(id integer,
name text), join on user_id, include orders after 2026-01-01 with total above 50,
group by user, and return the top ten by count.” Include schema/types and selected
requirements; omit incidental unchanged formatting knobs. State API response or
pipeline output requirements where those are the subject.

Verify add/remove filter, type error, empty selection, ordering/limit interaction,
preset/reset, hostile quote/HTML input, and prompt context. Test the actual local
computation if promised; a plausible formatted query alone is not proof of results.
