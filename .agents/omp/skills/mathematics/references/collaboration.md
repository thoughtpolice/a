<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified adaptation of Anthropic math-proof/skills/siege/SKILL.md and agents/math-proof-{judge,worker,worker-deep}.md, Apache-2.0, claude-plugins-official ab024cdc. -->

# Collaborative and adversarial proof

Use collaboration only after mapping substantial independent slices and shared
assumptions yourself. Follow repository delegation gates: task agents for
mathematical implementation/solving work, reviewers for proof review, scouts
only for genuinely unmapped read-only research. There are no model tiers,
mandatory identical launches, prescribed number of rounds, or automatic retries
of failed agents. One integration owner reconciles the mathematics and artifacts.

## Prepare

Preserve `problem.md`, keep the exact assumptions, and record the current goal
and phase in `state.md` if a resumable investigation is needed. Optional working
artifacts are `notes.md`, `summary.md`, `index.md`, a round ledger, and `proof.md`.
These are work products, not instructions supplied by a third-party plugin.
For structured rounds, use [the ledger contract](ledger.md).

Give every delegated question a self-contained statement and the complete
original problem. Include the exact arguments it may use, rather than a summary
of their purported result. State whether the task is to prove, disprove, find a
construction, check a specific step, or verify the complete chain. Name the
specific open obligation being attacked. Supply earlier partial work only as
unverified leads; the recipient must independently justify reused steps.

## Iterate on obligations, not on ceremony

1. Read returned material in full before relying on it. Screen refusals,
   off-topic work, and answers to a different problem separately from weak,
   wrong, or incomplete mathematical attempts. A finished artifact's marker
   means the writer finished, not that the conclusion is correct.
2. Update the running summary with established statements and their locators,
   promising partial results, exact failed claims and counterexamples, and the
   open gaps. Consult the actual result before relying on or contradicting it;
   a compressed summary may silently drop a hypothesis.
3. Append load-bearing claims to the ledger. Retract a failed claim explicitly;
   do not silently overwrite history. Tag the exact posed goal `[GOAL]` and
   critical obligations `[CRITICAL]`. A newer unsettled goal invalidates older
   certifications of completion. Record every support dependency by ledger ID.
4. Identify the shortest honest chain from settled results to the goal. State
   the missing statement with all quantifiers and hypotheses. If one statement
   does not suffice, say what would still remain after it. A narrower special
   case is not the missing statement unless the complementary cases are proved.
5. Choose genuinely different, valuable attacks. Prioritize the load-bearing
   open gap; include a counterexample attempt when plausibility is in doubt.
   Do not launch breadth or polishing work merely to fill a wave. If using the
   native round checker, at least half the planned queries must declare
   `kind: attempt` near their top and attack flagged obligations; complete-chain
   verification is itself an attempt to settle an obligation.
6. Treat progress as a proved universal result that advances the chain, a full
   proof/disproof, or a strictly simpler remaining statement with a re-derived
   chain. Equivalent reformulations and solved special cases remain useful
   standing results but do not by themselves close the hard case. A failed
   ansatz closes that candidate, not every route using the same broad idea.

## Verify the precise chain

Give independent verifiers the exact clean complete argument, the original
problem and assumptions, and the entry IDs they are certifying. Keep them blind
to discovery notes and other verdicts. Ask for each failed implication,
unverified theorem hypothesis, missing case, circular reduction, or concrete
counterexample. They should identify exact locations and explain the failure,
not vote by intuition. Use [the adversarial checks](verification.md).

For the ledger gate, record two positive `[AUDIT]` attestations from distinct
finished query locators, citing the current goal or its support chain; at least
one must cite the current goal itself. This is an attestation requirement, not
a statistical confidence calculation. Any substantive dissent must be resolved
mathematically, regardless of how many other reviewers agree. Retract invalid
claims, expose the gap, repair what can be repaired, and reverify the changed
argument. Incomplete verification reports may identify real errors, but their
missing final verdict supplies no certification.

## Respect the user's goal and preserve partial work

Do not replace a fixed posed claim with an easier one. On an explicitly
open-ended task, a stronger goal may be proposed after establishing a result,
but record and announce the changed target and preserve the established proof.
A raised goal is OPEN until proved. If it remains unresolved, the final document
may lead with the established theorem, then clearly separate the stronger
attempted statement. Returning to an earlier goal requires re-stating it with
its support IDs and audits citing the current entry—not silently reusing stale
audits. Never exclude a counterexample's class just to rescue the goal.

After rounds end, draft from all surviving results, including reductions,
reformulations and natural special cases. Review the full final draft, repair
only justified gaps, and write a stand-alone proof with Status and optional
Other routes. An exhausted planning retry yields TAIL: assemble honest available
material, not an unaudited declaration of success. The helper cannot solve or
verify the mathematics for you.
