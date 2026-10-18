<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified from Anthropic claude-plugins-official pr-review-toolkit/agents/pr-test-analyzer.md at ab024cdc (Apache-2.0); OMP rewrite. -->

# Behavioral test review

Map each changed public behavior to existing unit/integration coverage before proposing more tests. Ask which plausible consumer-visible bug an assertion would catch, not which lines lack coverage.

Inspect boundaries and transitions: empty/minimum/maximum input, malformed or unauthorized input, precedence, state changes, cancellation, resource cleanup, concurrency races, partial failure, and exhausted error handling where those occur in the change. Verify async tests await the actual result and isolate filesystem/state dependencies. Prefer deterministic cases proving output, state, or an error contract over timing guesses.

Reject brittle checks of incidental implementation, copied values, wiring, mock echoes, source wording, or bare not-throw. Do not recommend trivial getter tests or duplicate integration coverage. Existing tests pinning incidental wording/implementation should be removed, not re-pinned to a refactor. A meaningful regression should fail for a realistic wrong implementation and survive a behavior-preserving rewrite.

For each material gap, specify setup, input/action, expected observable result, and the regression it prevents. Rank by impact (data loss/security/system failure first, then user-facing logic, then uncommon boundaries), not coverage percentage. A missing test is not itself proof of a code defect. Record commands actually run and any unexercised paths; follow `skill://buck2/test-workflow/guide.md` when making changes.
