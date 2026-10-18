<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Session report

Modified from Anthropic's Apache-2.0 session-report instructions and analyzer,
[upstream ab024cdc](https://github.com/anthropics/claude-plugins-official/tree/ab024cdc/plugins/session-report).

## Select and mine

Call `session_analyze` with an explicit input root, exact `.jsonl` or `.jsonl.gz`
files, and timezone-qualified `since` / `until`. There is no global scan or
implicit last-seven-days window. For a seven-day report, calculate the explicit
requested endpoints once; use the returned normalized UTC window in the report.

Example selection shape (replace the root, filename, and window with actual
selected evidence):

```json
{
  "inputRoot": "/selected/omp-journals",
  "files": ["project/session.jsonl"],
  "since": "2026-09-01T00:00:00Z",
  "until": "2026-09-08T00:00:00Z",
  "html": "session-report.html",
  "csv": "session-report.csv"
}
```

For offline Bun use, save this selection as a JSON file under the current
workspace with the native file-writing tool, then run the bundled entrypoint:

```text
bun <skill-package>/scripts/session-insights.ts analyze selection.json
```

Resolve `<skill-package>` from this installed skill; do not invoke an upstream
research script. The entrypoint prints structured results and writes requested
artifacts through bounded private-output helpers. It installs no packages and
makes no model/network calls.

## Read the results

- `totals.usage` and session/day/model rows expose input, output, cache read/write,
  authoritative total tokens or complete-bucket derivation, orchestration tokens,
  and recorded cost. Every meter has `value`, `observedSum`, `observedRecords`,
  and `missingRecords`. A partial sum is not a complete total.
- `assistantMessages` and `supplementalUsageRecords` describe journal records.
  They are not provider call IDs. `model_usage` retains its explicit purpose.
- `sessions` use opaque identities. All recorded branches count as activity;
  linked forks and same-session resumed copies deduplicate inherited entries.
  Unrelated sessions with equal short entry IDs remain separate.
- `requests` expose up to 1,000 chronological usage-record contexts. The
  `requestContextOmitted` count discloses truncation; aggregate meters cover all
  selected records. Parent ancestry—not the most recently serialized prompt—
  links a record to its opaque user-prompt identity.
- `tools` distinguish attempted, successful, failed, and unknown results.
  A tool attempt is not success. Task result facts show child identity, explicit
  agent and duration when present; task aggregate usage is not counted again.
- `skills` counts successful `read` results for `skill://` resources, not claimed
  invocations or guessed `/slash-command` usage. Skill spend is not inferred.
- `wallMs` is the sum of individual session envelopes spanning selected activity
  timestamps and clipped runtime endpoints; `first` / `last` expose those bounds.
  Runtime-only sessions use their clipped runtime bounds, not outside event
  timestamps. Overlapping sessions can overlap in wall time.
- `activeMs` is the union of explicit assistant/model and tool execution
  intervals overlapping the window, independently of their event timestamps.
  Deduplicated intervals are clipped and split at UTC midnight. Runtime alone
  contributes session/day membership, but never outside-window prompts, usage,
  outcomes or metadata. Nonoverlapping and boundary-touching intervals do not
  create zero-valued activity. Usage stays on its selected event date.
  `timingGaps` describes missing timing on selected events only; neither timing
  metric measures human work.

Enable `includePrompts: true` only when the user explicitly requests prompt
analysis. `topPrompts` shows the top 100 by observed token usage, with up to
1,000 characters of text and partial-usage metadata. It does not silently roll
unselected child journals into parent prompts.

Enable `includeCacheBreaks: true` only for a requested cache review. The top 100
rows show uncached input (`input + cacheWrite`) above `cacheBreakThreshold`
(default 100,000), explicit cache read, previous observed uncached input, and
whether the recorded model changed. High uncached input is evidence, not proof
that a cache broke. Missing preceding input/model evidence stays unknown.

## Write and verify

Use the [report outline](../assets/report-outline.md). Give a few concrete
findings and recommendations when the data supports them; do not fill a quota
with speculation. The generated offline HTML has sortable/filterable daily
usage, metric cards, structured session/tool/model/task/skill/request drilldowns,
full JSON, caveats, and a formula-neutralized CSV download. Separate CSV files
carry the same missing-data and inference caveats. There are no external fonts,
CDNs, or telemetry.

Open the actual saved page for verification. Sorting/filtering and CSV download
must work offline; the browser should make no network requests. A blank/unknown
meter should remain visibly unknown rather than becoming zero.
