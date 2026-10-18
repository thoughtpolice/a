<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified from Anthropic claude-plugins-official code-review/commands/code-review.md and pr-review-toolkit/agents/code-reviewer.md at ab024cdc (Apache-2.0); confidence separated from severity. -->

# Evidence, confidence, and noise

A finding needs a specific contract, reachable counterexample, relevant changed code, and impact. Read a purported project rule literally and cite its scope; do not invent a style mandate. Historical comments and previous review decisions inform intent but do not override the current contract.

Before reporting, attempt to disprove it: inspect caller validation, safe input provenance, actual API semantics/version, cleanup, intentional behavior changes, and tests that exercise the case. Exclude pre-existing defects unless the change makes them newly reachable; explain that linkage. Cite changed lines even when supporting evidence is elsewhere.

Suppress speculative bugs, nits, unsupported general security claims, optional polish, and duplicated root causes. Do not flood a review with compiler/linter-only findings already handled by existing checks. A documented exception can explain intent, but a comment asserting safety is not proof of a dangerous data-flow guard.

Confidence is evidence strength, not importance: 0 = disproved/pre-existing, 25 = unsupported possibility, 50 = incomplete causal evidence, 75 = strong but missing a material prerequisite, 100 = concrete complete counterexample. Report defect findings only at ≥80. Do not inflate a score to include a favorite suggestion. Separately label requested design/test/comment improvements without portraying them as confirmed defects.

Severity is consequence: critical = realistic catastrophic compromise/loss, high = major user-visible break/security impact, medium = limited but material break, low = smaller confirmed defect. State the triggering conditions; rarity affects prioritization, not truth.

Output highest-severity findings first:

- **[Severity] Short actionable title** — `path:line-range`, confidence N/100.
- Trigger and contract violation; observed evidence or clearly labeled static reasoning.
- Actual consequence and smallest concrete correction.
- Cite relevant supporting code/rule. For a hosted PR use immutable revision links with real resolved commit IDs; never fabricate URLs or line ranges.

Finish with reviewed scope, verification actually exercised, and material limitations. If nothing qualifies, say “No confirmed findings in the reviewed scope,” not “the code is safe.” Never publish to a PR unless explicitly requested.
