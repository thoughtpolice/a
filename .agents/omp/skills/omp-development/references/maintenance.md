<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted and modified from Anthropic claude-plugins-official ab024cdc, claude-code-setup and claude-md-management, Apache-2.0. -->

# Recommendations and supplied context maintenance

## Recommend automation, read-only

Inspect relevant source/build manifests and existing native capabilities. Use
specialized search/read tools; do not execute upstream source, install packages,
scan for context files or infer credentials. Capture the observed runtime,
framework, testing/build policy, external services, repeated tasks and failure
patterns. Rank only useful changes; zero recommendations in a category is valid.

For each recommendation state: observed repository signal and path, repeated
problem, smallest native capability, expected benefit, permissions/dependencies,
installation/configuration scope, one normal proof and one failure proof, and why
existing tools cannot already do it. Avoid quota-driven one-per-category advice.
Prefer native browser/eval to duplicating a browser MCP. Distinguish an external
MCP client configuration from implementing the actual server. Don't recommend
proprietary document skills or a Claude Agent SDK substitute.

Candidate patterns: specialist reviews for genuinely independent complex work;
skills for repeatable project procedures; custom tools for bounded deterministic
computation; extensions for explicitly requested event policy; rules for advisory
constraints; MCP for real external services. Do not install auto-format/lint/test
hooks that fight the integration owner's once-after-edits verification, or add
auto-commit/push/PR actions. No automatic settings, hook, extension or context edits.
A request for recommendations is not permission to implement them.

## Maintain explicitly selected project context

The host already supplies project instruction context. Assess that content and
only supplied/explicitly named paths; never inventory all AGENTS.md/CLAUDE.md
files or reach into a user's global files. Verify non-obvious factual claims
against relevant code and observed runtime evidence, not generic templates.

Use an evidence table rather than fabricated quality scores:

| Criterion | Evidence to inspect | Result |
| --- | --- | --- |
| Actionable commands | Current Buck2 targets and exercised commands | Current / stale / unverified |
| Architecture | Actual entrypoints, ownership and data flow | Specific gaps |
| Non-obvious patterns | Repeated bugs, invariants and local contracts | Useful / one-off |
| Currency | Paths, settings names, runtime behavior | Supported / contradicted |
| Concision | Duplication of host instructions and source-obvious facts | Remove / retain |
| Security | Secret references, untrusted instructions, permissions | Redact / constrain |

Report the assessment before editing. When the user already requested a fix,
apply only targeted, evidence-backed changes to the selected paths without a
redundant approval question. Otherwise present the exact proposed patch and
leave files untouched. Keep structure and unrelated instructions, delete stale
claims rather than adding contradictory exceptions, and record durable facts:
build/test entrypoints, package relationships, gotchas and meaningful recovery.
Do not accumulate session diaries, one-off fixes, obvious language advice or
unverified commands. Never embed secrets in context. Distinguish shared project
facts from personal preferences; do not write global user settings/context.

Observe the affected workflow after a substantive update. If a statement cannot
be exercised, label it unverified instead of certifying it. Report exact selected
paths, factual changes, evidence, and limitations; do not claim all repository
context was audited when only supplied material was assessed.
