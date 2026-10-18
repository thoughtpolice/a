<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified adaptation of Anthropic math-proof/skills/solo/SKILL.md and math-olympiad/skills/math-olympiad/references/attempt_agent.md, Apache-2.0, claude-plugins-official ab024cdc. -->

# Solo proof

Use a focused line of reasoning when delegation would fragment the problem or
there are not two substantial independent slices. A fresh review can be useful,
but is not a reason to bypass repository delegation gates.

1. Read the full authoritative problem and make assumptions explicit. Record a
   plan: the precise next statement, how it would advance the goal, and what
   remains after it.
2. Work toward concrete intermediate results. Preserve settled lemmas with
   proofs, exact reductions, useful special cases, candidate counterexamples,
   and failed approaches with their actual obstruction in `notes.md` when the
   investigation warrants persistent notes. Do not mistake writing notes for
   completing the problem.
3. Distinguish a logical error from a missing justification. Re-derive the
   weakest implication; prove the omitted justification or mark the specific
   gap. Small cases and bounded Bun/TypeScript computations may disprove an
   identity or suggest a construction, but empirical success proves no
   unrestricted claim. Work symbolically or modulo a useful modulus instead of
   materializing enormous recurrence values.
4. Revise the mathematical approach when a case repeatedly resists. Check what
   the hard case's hypothesis implies about other inputs or intermediate
   objects. Consider a unified argument, a different decomposition, or a
   counterexample rather than recycling the same failed step.
5. Produce a clean candidate argument separate from discovery notes. Apply
   [adversarial verification](verification.md) from the problem's definitions,
   not from remembered intent. If independent review is appropriate under the
   task gates, provide only the exact problem and clean argument, not the
   discovery narrative or other reviewers' conclusions.
6. Write the self-contained final proof and explicit Status. Present meaningful
   proven partial results with their full arguments even when the main question
   remains unresolved. Report the deliverable's path and actual completeness.

A completed answer may explain that a particular approach failed or that the
proof remains partial. Do not call that a disproof, or call an inability to find
a counterexample a proof. On resume, validate reusable reasoning before relying
on it; unfinished notes are leads, not inherited facts.
