---
name: session-insights
description: Mine selected OMP session journals for usage, cache, runtime, tool/task/skill evidence, or produce personal work receipts correlated with explicit jj history. Use for session reports, usage reviews, impact receipts, and private offline HTML/CSV exports—not provider billing reconciliation or inferred productivity savings.
---

<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Session insights and work receipts

Rewritten from Anthropic's Apache-2.0 `session-report` and `receipts` plugins,
`claude-plugins-official` at `ab024cdc`. This package mines OMP journals locally;
it does not install hooks, scan home directories, send telemetry, or publish reports.

1. **Select evidence.** Identify the user's explicit journal input root and files,
   inclusive `since` and exclusive `until` ISO timestamps with timezone. Do not
   discover every session globally or execute anything in research source clones.
   Select parent and child journals explicitly if their usage should be included.
2. **Choose the workflow.** Read [session-report](references/session-report.md)
   for usage/runtime reviews; read [receipts](references/receipts.md) for completed
   work and jj correlations. Both workflows mine raw journals—not a caller's
   precomputed metrics.
3. **Mine and export.** Invoke native `session_analyze` or `work_receipts` using
   its active schema (`xd://session_analyze`, `xd://work_receipts`). Alternatively,
   use the [Bun entrypoint](scripts/session-insights.ts) with an explicit JSON
   selection as described in either guide. Native tools and CLI share one miner.
   Outputs stay under the current workspace; existing files require explicit
   `overwrite: true`. Do not use shell redirection for artifact writes.
4. **Explain the evidence.** Use [report outline](assets/report-outline.md).
   Distinguish observed data, partial totals, and unknowns. Report findings only
   where evidence supports them; never invent missing provider calls, PR success,
   causality, time saved, or monetary value. Do not attribute model spend to a
   tool activity or split session spend across projects with guessed ratios.
5. **Review locally.** Inspect the saved HTML in a browser. Check sorting/filtering,
   drilldowns, missing-data labels, and CSV export. Keep findings grounded in the
   structured output. Before sharing, disclose explicit project labels and any
   enabled prompts/paths; do not publish, commit, push, or post automatically.

Default output uses opaque session/project identities and excludes prompts,
titles, task text, and filesystem paths. `includePrompts` deliberately reveals
bounded prompt/task excerpts; `includePaths` reveals receipt file paths relative
to selected project roots. Cache-break evidence is also opt-in and identifies
large uncached inputs—not a proven cache failure or its cause.

See [limits and source map](references/source-map.md) for exact scan limits,
OMP record mapping, deliberately omitted Claude-only metrics, and provenance.
