---
name: code-simplifier
description: Simplify recently changed code for clarity and maintainability while preserving behavior, errors, side effects, and performance. Use for a requested cleanup or focused post-correctness refactor, not feature changes or broad rewrites.
---
<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified from Anthropic claude-plugins-official code-simplifier/agents/code-simplifier.md and pr-review-toolkit/agents/code-simplifier.md at ab024cdc (Apache-2.0); removed automatic activation, model tiers and canned language style rules. -->

# Simplify without changing the contract

1. Identify the requested/recently modified sections and applicable repository conventions. Read callers and relevant tests before editing. Resolve confirmed correctness defects first; use `skill://code-review` when a review is needed. Do not use simplification to slip in new behavior.
2. Read [the preservation checklist](references/preservation.md). Write down observables at risk: outputs, errors, side effects/order, state/ownership, concurrency, and performance. If a supposed cleanup changes those, treat it as a separate change requiring an actual task basis.
3. Prefer clear names, guard clauses where order is unchanged, fewer unnecessary nesting levels, removal of proven redundancy/dead code, and consolidation of genuinely identical logic. Use syntax-aware edits for structural changes and LSP to migrate references.
4. Retain helpful abstraction, debugging boundaries, rationale comments, and separation of concerns. Prefer explicit branches to dense one-liners or nested ternaries. Do not impose upstream ES-module/function/React conventions over local patterns, or change code just to reduce line count.
5. Keep focused work inline. Delegate native `reviewer` only when independent substantial review slices justify it; do not create a new specialist agent or mechanical fanout. Keep editing ownership clear.
6. Exercise the behavior-preserving changed path and repository checks using `skill://buck2-test-workflow`; report only executed results. Permanent tests should catch real uncertain boundaries, not pin the new implementation. Update existing docs only when needed and remove obsolete code rather than adding aliases/shims.

Return significant simplifications, scope, behavior exercised, and residual uncertainty. Do not automatically commit, push, post a PR, or widen scope to unrelated code.
