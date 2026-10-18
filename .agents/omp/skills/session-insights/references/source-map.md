<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Limits and source map

## Included compatible upstream behavior

Source: Anthropic `claude-plugins-official`, pinned `ab024cdc`, Apache-2.0
plugin licenses. Files below were read as source only; no upstream executable,
fixture generator, dependency manager, or test was executed.

| Upstream file | OMP adaptation |
| --- | --- |
| `plugins/session-report/skills/session-report/SKILL.md` | Explicit selection → local mining → evidence-backed findings/recommendations → private HTML/CSV workflow |
| `plugins/session-report/skills/session-report/analyze-sessions.mjs` | Resume deduplication, token/cache and session/day aggregation, prompt ancestry, tool/task/skill evidence, opt-in top prompts and large uncached-input evidence; rewritten for OMP records |
| `plugins/session-report/skills/session-report/template.html` | Offline metric cards, sortable usage tables and expandable evidence; renderer rewritten for the OMP schema and privacy, not a copied Claude template |
| `plugins/receipts/skills/receipts/SKILL.md` | Local evidence, completed work, unknown/zero distinctions, nonadditivity, truthful impact framing and pre-sharing privacy review |
| `plugins/receipts/skills/receipts/scripts/mine-transcripts.mjs` | Successful-result filtering, file-first attribution, bounded history correlation, HTML/script escaping, formula-neutralized CSV, offline downloads; rewritten for native OMP and read-only jj |

The packaged Bun entrypoint, native tools, tests and narrative outline are new
OMP-native implementations/adaptations. The repository's Apache-2.0 license
covers these derivatives; upstream source files contain no specific additional
copyright/NOTICE text to reproduce. See the pinned
[session-report license](https://github.com/anthropics/claude-plugins-official/blob/ab024cdc/plugins/session-report/LICENSE)
and [receipts license](https://github.com/anthropics/claude-plugins-official/blob/ab024cdc/plugins/receipts/LICENSE).

Excluded assets: `plugins/receipts/assets/make-sample.mjs` (synthetic HOME and Git
writes), `plugins/receipts/assets/sample-receipt.png` (illustration, not evidence),
`plugins/receipts/README.md` (sample/marketing narrative), original Node CLI
entrypoints and source HTML
copies. No Claude hook/CLI/settings/model-tier/telemetry glue is imported.
No proprietary `claude-security` or document-skill source is used.

## Source-only OMP mapping

Structural record semantics were inspected in OMP's source tree:
`packages/stats/src/trace.ts`, `parser.ts`,
`packages/coding-agent/src/session/session-manager.ts`, native `tools/read.ts`,
`write.ts`, `ast-edit.ts`, `edit/index.ts`, and agent-loop tool-result recording.
These are behavioral mapping references, not executable dependencies or copied
SDK source.

- A `session` header supplies session identity, cwd and optional parent session
  ID/path. Parent links are resolved only among explicitly selected journals.
- Entry `id` is session-local; linked lineage + original timestamp + entry type
  and message role forms the replay identity. Ancestors are processed before
  descendants, preserving original usage rather than a fork's zeroed inherited
  cost. Unrelated roots with equal short IDs do not collapse. Missing identity
  fields are counted as gaps and never silently deduplicated.
- All recorded branches count as historical activity, including superseded
  branches. The latest disk record is **not** assumed to identify the active
  branch: branch-owned writes/model_usage may append without moving the live
  leaf. Parent links identify nearest nonsynthetic user prompt context.
- Persisted `message.role: assistant` and `model_usage` carry real `usage.input`,
  `output`, `cacheRead`, `cacheWrite`, `totalTokens`, optional orchestration and
  `cost.total`. A valid total is authoritative; otherwise only a complete set
  of buckets is derived. Missing/invalid counters remain unknown. Task-result
  child usage rollups are excluded from usage aggregation to prevent duplication.
- Model intervals require explicit message timestamp/completedAt/duration.
  Tool intervals join `customType: tool_execution_start` data to toolResult by
  actual toolCallId; no start times or provider request IDs are fabricated.
- `task` results carry `details.results` child IDs, agent/task/duration evidence.
  No child transcript path/classification is guessed from directory names.
- Native read/write/edit/ast_edit result fields, not requested path selectors,
  supply completed filesystem activity. Native agent-loop journals persist a
  boolean `isError`; old/foreign absent status remains unknown.
  Relative pre-fork results are not rebased to a fork's different cwd; absent
  creation time leaves fork-relative attribution unknown.

## Exact bounds and omitted metrics

- Explicit files only, 1–256 selected paths; duplicate absolute input files read
  once. Symlink components and paths escaping the input root are rejected.
- 8 MiB per compressed input and decoded journal; 64 MiB total decoded input;
  at most 200,000 entries across the selection. `.jsonl.gz` is bounded with
  Node-compatible gzip decompression. There is no directory/global scan.
- Endpoints must be ISO timestamps with explicit timezone; intervals are
  half-open and day buckets UTC. Maximum window is 36,600 days. Future/undated
  activity is not guessed into the window; undated entries are counted.
- Only a crash-truncated final JSON record is tolerated and disclosed;
  interior corruption, missing header or invalid record type fails the input.
- Request-context drilldown caps at 1,000 and discloses omitted count; totals
  remain complete for selected records. Requested top prompts/cache evidence
  cap at 100 rows each; requested prompt/task text caps at 1,000 characters.
- 1–16 explicit jj root/revset scopes. `maxCommits` defaults to 500, range
  1–2,000 per scope; one extra record detects truncation. History output and
  each HTML/CSV export cap at 8 MiB. CLI subprocesses also enforce 8 MiB buffers
  and 30-second jj deadlines. Native subprocess cancellation uses the host API.
- CLI selection JSON caps at 1 MiB. Outputs are atomically published private
  regular files under the current workspace and refuse overwrite by default.
JSON and journal text require valid UTF-8; decoding errors are not repaired
into different evidence. Native tool loading and YAML validation were exercised
in OMP v18.4.8 with Bun 1.4.2.

Deliberately omitted: Claude API-response splitting/request IDs, Claude model
ratios and token-weighted spend shares, tool-derived spend attribution, Git
writes/log/config, implicit home scan, guessed subagent types or unselected
child usage, cache causal diagnoses, provider bill reconciliation, PR creation
attempt/success counters, savings/value estimates, forced commentary quotas,
external fonts and sample screenshots. Daily tables replace the Claude-only
project gantt/peak-concurrency display; no unsupported task/provider calls are
invented to recreate it. Unknown journal fields remain unknown.
