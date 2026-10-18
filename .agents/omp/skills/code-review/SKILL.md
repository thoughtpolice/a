---
name: code-review
description: Review a change or pull request for confirmed defects, project-rule violations, comment accuracy, behavioral test gaps, error handling, and type invariants. Use for focused or comprehensive review, not automatic posting or edits.
---
<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified from Anthropic claude-plugins-official at ab024cdc: code-review/commands/code-review.md and pr-review-toolkit/commands/review-pr.md, agents/code-reviewer.md (Apache-2.0). Rewritten for OMP. -->

# Review changed code

1. Establish the requested base/revision, changed files, and review aspects. Read the supplied diff/PR via native PR/read tools and applicable `AGENTS.md` rules. Describe actual intended behavior before looking for defects. For a closed/draft/already-reviewed PR, report its state; do not silently skip an explicit user review request.
2. Read changed sections and enough callers, contracts, tests, and history to decide whether behavior is intentional. Use `find` for unknown implementation locations, `grep` for known symbols, and LSP for type/call relationships. Do not assume a diff hunk contains the whole contract.
3. Always examine changed-code defects; select other facets by relevance, not just whether corresponding test files changed:
   - Comments/docs or changed behavior invalidating existing docs: [comments](references/comments.md).
   - New behavior, boundaries, or error paths: [tests](references/tests.md).
   - Catch/Result paths, defaults, cleanup, or fallback: [errors](references/errors.md).
   - New/changed state models, construction, or mutation: [types](references/types.md).
   - Trust-boundary changes: read `skill://security-review`.
4. Work inline for a focused review. Delegate genuinely independent, substantial slices to native `reviewer`; use `security-reviewer` for security investigation. Supply revision/scope, applicable rules, evidence requirements, and read-only intent. No fixed agent counts, model tiers, or automatic fanout. Integrate and independently check candidate findings rather than accepting votes as proof.
5. Validate each candidate against the actual contract and counterexamples. Trace a concrete failing input or state; exercise the changed path when feasible and authorized. Distinguish observed output from static reasoning. Use repository verification policies, not upstream assumptions that CI will catch everything.
6. Apply [evidence and noise filtering](references/findings.md), deduplicate the same root cause, and return a concise cited review. If requested, separate test/comment/design suggestions from defects. No automatic edits, commits, pushes, or PR posts.

After correctness issues are resolved, use `skill://code-simplifier` when simplification is requested or warranted by the task. A review is not permission to rewrite unrelated code.
