<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified adaptation of Anthropic math-olympiad/skills/math-olympiad/SKILL.md and references/{adversarial_prompts,verifier_patterns}.md, Apache-2.0, claude-plugins-official ab024cdc. -->

# Adversarial proof verification

Review the authoritative statement plus the clean proposed argument. Separate
the proof from its discovery narrative, false starts and self-certification.
When independent review is justified under repository gates, do not supply
other reviewers' verdicts or suggest how they voted. Independence is useful;
a fixed number of approving agents is not mathematical evidence.

Try to break the argument from first principles. Return **HOLDS**, **HOLE FOUND**
or **UNCLEAR**, the exact quotation/location, the reason, an explicit
counterexample if available, and whether a repair is justified. A positive
report should explain the hardest step it actually checked. Do not say HOLDS
merely because no immediate objection came to mind, or report computation you
did not perform.

## Checks

1. **Interpretation:** list plausible readings before examining the proof.
   Check all-versus-one, necessity-versus-sufficiency, admissible degeneracies,
   exact-versus-asymptotic, and formula-versus-characterization. A surprising
   short solution is a reason to inspect scope, not proof that a harder reading
   must be intended.
2. **Implications and inequality directions:** trace every inference. For
   example, `A>B` and `C>D` do not imply `A-C>B-D`. Inspect divisions, signs,
   equality conditions and strictness. Replace "obviously" with the argument.
3. **Hypothesis class:** state every invoked theorem precisely and verify each
   hypothesis from the definitions. Match pointwise versus averaged, uniform
   versus almost everywhere, finite versus asymptotic, and local versus global
   assumptions. Check the theorem's actual conclusion against what is needed.
4. **Scope of formulas:** trace where an identity was proved and what assumptions
   were standing there. Do not extend a special-case formula silently.
5. **Boundary and small cases:** identify the first nontrivial structural block
   and test beyond it. Check zero, one, empty, equality, tangency and singular
   cases when admissible. A claimed counterexample must satisfy all assumptions.
6. **Too much generality:** strip the argument to properties actually used and
   try a familiar false or known-open substitute. A suspicious consequence is
   a diagnostic, not itself a refutation; identify the failing implication or
   the special property the original object genuinely uses.
7. **One-line load-bearing lemma:** extract its general statement and try the
   smallest nontrivial counterexample. Rank does not depend only on support:
   `[[1,1],[1,1]]` and `[[1,1],[1,-1]]` have the same support but different rank.
   If the general principle fails, either prove the special structure making
   this instance work or expose where the conclusion fails. Passing a small
   test alone does not establish the lemma.
8. **Circular reduction:** substitute the chain's own identities into its final
   estimate. If this recovers the original claim, the chain has renamed the
   problem, not discharged it. Inspect direct and transitive dependencies;
   verification cannot be a premise for the result being verified.
9. **Proxy obstruction:** if several routes fail for the same reason, identify
   the object exhibiting the obstruction. Recheck the original object instead
   of assuming a reduction's obstruction transfers back.
10. **Mean versus absolute value:** an absolute-sum bound may discard
    cancellation. Decompose into mean and fluctuation when justified; prove
    the mean and any orthogonality or variance claim instead of assuming them.
11. **Infinite operations:** justify limit/sum/integral interchange, convergence
    and endpoint behavior. Analytic continuation is not the original series
    outside its convergence domain; a pole does not provide a finite bound.
12. **Quantifiers:** count alternations before diagonalizing or certifying a
    witness. Shrinking a domain makes a universal statement weaker and an
    existential statement stronger. Verify the actual direction of reductions.
13. **Crux and coverage:** a claimed standard argument must supply the hard step.
    An existence construction without necessity, or an upper bound without
    achievability, does not resolve an exact-answer problem.

## Repair

Classify a broken implication as a logical error, and an unsupported but
potentially true implication as a justification gap. Give a reviser the clean
proof and the concrete issue, not the original discovery trace. For a false
general lemma, require either a proved instance-specific replacement or a
counterexample to the intended claim; "it still looks fine" is not a repair.

Recheck the revised full chain, especially changed assumptions and cases. If the
same gap persists, reconsider the decomposition instead of accumulating votes.
Preserve all genuinely proved material. Mark an unresolved point inline as
`[GAP: exact missing statement]` and in Status. An incomplete reviewer report
can expose a real defect but cannot provide a positive final certification.
