<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Report outline

Modified from Anthropic's Apache-2.0 session-report/receipts narrative workflows,
`claude-plugins-official` `ab024cdc`. Use the mined results as evidence; do not
copy an example claim or fill missing values with guesses.

## Scope and provenance

State the returned UTC window (end exclusive), selected journal count and
explicit history scope. Distinguish scanned files/entries from sessions and
completed file work. Call out malformed tails, identity/date/usage/timing gaps,
unselected child journals, and truncated/unavailable history when present.
Do not expose source filenames, prompts or project names without consent.

## Session report findings

Use a few specific findings tied to actual rows: known/observed token totals,
cache buckets, model mix, measured runtime and its missing intervals, tool
success/error/unknown outcomes, explicit task facts and successful skill reads.
For partial meters, give observed totals **and** missing-record count instead
of percentages that imply a complete denominator. Top prompts/cache observations
belong here only when explicitly requested.

Give actionable recommendations only where observations support them. Large
uncached input alone does not prove a broken cache, and task count does not
prove waste. Avoid unsupported cache targets/model ratios and forced findings.

## Work receipt

Lead with distinct files successfully changed/read, completed native operations,
known touched-line extents with unknown extents disclosed, and qualified jj
path/time correlations. Name these "commits intersecting recorded changed
files", not "commits the assistant shipped". Show unknown history as unknown,
not zero. Describe sessions/active days as engagement, not impact by themselves.

Use the project rows for scope membership. Explicitly state that sessions,
active days and commit memberships are not additive; shared-history totals are
deduplicated by commit ID. Do not reconstruct a project/tool spend allocation.
Recorded cost is local metadata, not a bill or value created. No inferred PR
successes, time saved or dollar savings belong in the receipt.

## Personal context and sharing

If separately verified context exists, add one or two concrete wins and cite
its evidence separately from mined activity. Organizational verified metrics
remain the authority for shipped output. List the explicit labels/relative file
paths or prompt/task excerpts the exported report reveals before sharing.
Return the local HTML/CSV paths. Publishing, committing, pushing or posting is
a separate explicit action, not part of mining.
