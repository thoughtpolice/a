<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted from Anthropic project-artifact/skills/project-artifact/swe.md, Apache-2.0, ab024cdc. Modified for repository/native read tools, explicit evidence and local refresh; no Git writes or publishing. -->
# Software projects: PR workstreams

Apply [the base workflow](SKILL.md) and [JSON contract](references/spec.md).

## Gather real state

Use native PR/repository tools (for example `pr://<owner>/<repo>/<number>`, issue
reads, and the mounted read-only API); inspect available schemas instead of
inventing endpoints. Record repository, author, actual project branch prefix,
source queries, and observation timestamps in evidence detail so another refresh
can repeat the gather. Open PRs are the union of author and branch-prefix results,
deduplicated by **repository + number**, including teammates/bots. Enumerate all
pages/limits; a truncated query is incomplete evidence, not a definitive absence.
Include recently merged project PRs as done work; do not accidentally pull unrelated
work just because it shares an author.

For each meaningful PR obtain title, URL, head branch, draft state, mergeability,
review decision/requests, required checks, and unresolved review threads. Required
CI is the gate; advisory bot failures are not automatically blockers. Thread counts
come from actual `isResolved:false` review threads, not REST top-level comment
counts; paginate review-thread results. Missing/auth/rate-limit/unsupported access
is unknown or stale, never zero failures/zero unresolved threads by assumption.
Read the PR body and relevant commit/source evidence for a verification narrative.
Use repository-supported read tools and Buck2 workflows, not an external build
system or automatic Git commits/posts. The renderer consumes these observations;
it does not query PRs itself.

Map PRs to workstreams by confirmed branch/title/tracker conventions. Label inferred
matches and their basis; unmatched PRs go in a stated catch-all, not a guessed row.
Summarize/link design docs rather than replacing them. Identify actual feature
flags from repository source and put relevant gates in the phase/banner text.

## Sequence and persisted PR state

Number stages **X.Y**: increasing X means the next stage depends on the preceding
stage; Y distinguishes work that can land in parallel (`1.0`, `1.1`, then `2.0`).
Numbers carry the sequence; avoid a gratuitous dependency diagram. Store a stable
row `id` (repository + PR identity where possible) separately from the stage label.
Keep exact PR state keys in each workstream:

`{repo,number,workstream,draft,ci,unresolved,state}`

These augment `id,title,owner,status,evidence,freshness,observed_at/reason` rather
than replacing the local evidence contract. CI/state are explicit text, counts
integers, draft boolean. Refresh reports CI flips, thread movement, new/removed
PRs, merged transitions, blockers, and freshness changes. It never equates an
omitted PR with merged; retain it stale unless current evidence establishes removal.
A merged stage can be summarized in prose, but keep individual PR entries in state
so future deltas remain unambiguous.

## Per-PR detail and optional rigor

Use `detail` for what landed, meaningful file changes, confirmed findings/fixes,
and real commit identifiers; use `verification` for observed tests, adversarial
workflows, actual smoke runs, and gating results. Distinguish planned verification
from performed verification. At proposal stage create real planned workstream rows
with `next` status and unknown/current planning evidence; never invent commits.

Add optional sections only with real content: architecture (trust boundaries,
file responsibilities), findings/fixes (bug + fix + verification), rollout/rollback
(gate ramp, measured thresholds, recovery steps), risk/open questions, decisions.
Group requirements by must-have/nice-to-have or product/security/performance, each
with falsifiable checks. Do not declare a requirement complete because a scaffold
compiled or an advisory check happened to pass. Keep all source text safely rendered
as data and review repository names/private links before sharing the local HTML.
