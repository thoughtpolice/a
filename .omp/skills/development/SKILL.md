---
name: development
description: Implement a substantial feature or architectural change by tracing existing behavior, defining observable acceptance, choosing a repository-native design, and verifying the complete user path. Use for unfamiliar subsystems, multi-file features, architectural planning, or iterative implementation—not routine mechanical edits.
license: Apache-2.0
---

<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Develop a feature from evidence

## 1. Define the contract

Extract the requested behavior, inputs, outputs, affected consumers, constraints,
and named acceptance criteria. Separate a requested feature from tempting adjacent
cleanup. Make each criterion observable: a state transition, command output,
persisted value, UI interaction, or error visible to a consumer.

Use repository evidence to resolve implementation details. Ask only when the user
must choose a materially different product or compatibility tradeoff; do not make
confirmation or a list of hypothetical edge cases a prerequisite to ordinary work.

## 2. Trace the existing path

Start with descriptive Find for an unmapped behavior, then read the returned
ranges. Use LSP definitions/references for code relationships when available.
Trace from the API/CLI/UI entry through validation, transformations, state,
persistence, and the final output. Include error/cancellation behavior and actual
callers. Read similar features before introducing another convention.

The [exploration and design contract](references/architecture.md) lists the useful
outputs of this investigation. Delegate independent unmapped slices only after
inline scoping; a scout returns evidence, not an implementation plan to obey.

## 3. Choose the smallest complete design

Write down the changed interfaces/state fields, existing patterns reused, files
owned by each slice, and verification that can break the design. Choose one boring
approach with its reason and tradeoff. Compare alternatives only where they would
change the outcome; do not manufacture an architecture competition.

For a rewrite, version uplift, or a behavior-preserving migration, read
`skill://modernization`. For an isolated checkout, read
`skill://jj/workspace-experiments/guide.md`.

## 4. Implement and iterate against acceptance

Plan multi-file work before edits. Keep one integration owner for shared contracts
and give workers explicit inputs, outputs, ownership, and non-goals. Avoid hidden
allocations/copies and needless abstraction. Migrate every caller together and
remove obsolete paths rather than shipping aliases or partial cutovers.

For a bug, reproduce the reported path before changing its cause; a user-reported
failure is already evidence, not an invitation to rerun it unchanged. Iterate by
fixing the first actionable failure, exercising that path, and retaining a
regression only when it catches a plausible consumer-visible defect. Do not use
stop hooks or repeat model calls as a substitute for a concrete acceptance check.

## 5. Prove the user path

Exercise the actual program/API/UI and observe output/state; passing tests alone
are not runtime proof. Run relevant Buck2 tests and include downstream consumers
using `skill://buck2/test-workflow/guide.md`. Do not duplicate already covered test
passes or broaden into unrelated applications.

Review the touched behavior using `skill://code-review`; use
`skill://code-simplifier` for a focused behavior-preserving cleanup only after the
implementation works. Resolve confirmed defects, update affected docs, and remove
throwaway fixtures. Report exercised evidence and limits, not hypothetical results.

## Source

Modified OMP-native adaptation of Anthropic's Apache-2.0
[feature-dev workflow](https://github.com/anthropics/claude-plugins-official/blob/ab024cdc/plugins/feature-dev/commands/feature-dev.md)
and its explorer/architect roles. Claude commands, model choices, mandatory agent
waves, approval ceremonies, and Git automation are not carried over. The useful
feedback loop from the Apache-2.0 `ralph-loop` is acceptance-driven iteration here,
not an automatically installed continuation hook.
