<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified adaptation of Anthropic math-olympiad/skills/math-olympiad/SKILL.md and references/{solver_heuristics,known_constructions,attempt_agent}.md, Apache-2.0, claude-plugins-official ab024cdc. -->

# Problem-solving and constructions

Interpret the exact question first. Select a useful starting angle rather than
mechanically launching one solver per heuristic. For a problem set, preserve
each problem's ID, statement, verdict, proof and gaps separately. Independent
substantial problems may run concurrently only under repository task gates.

## General moves

- **Specialize:** solve small cases, including a case past the first structural
  threshold. Distinguish evidence from proof; a degenerate small case can hide
  the obstruction.
- **Generalize:** a broader statement may expose more structure. Prove it only
  if it actually implies the original statement and its hypotheses hold.
- **Drop a condition:** find exactly where the claim becomes false. The failed
  examples reveal why a hypothesis is load-bearing.
- **Work backward:** identify sufficient statements and reconnect the backward
  chain to independently proved premises. Do not assume the desired conclusion.
- **Introduce an auxiliary object:** a reflected point, a useful function, a
  new variable, a generating function, or a different parametrization.
- **Find invariants, monovariants and extremal objects:** use parity, a residue,
  a conserved quantity, or a largest/smallest object with extra structure.
- **Double count or color:** count the same incidences two ways or expose a
  parity obstruction.
- **Smooth an inequality:** show that a justified perturbation moves the
  objective in the desired direction, preserves constraints, and reaches the
  asserted extremum. State equality cases.
- **Use symmetry carefully:** WLOG must preserve the hypotheses and conclusion;
  check that every original case is represented.

## Geometry

Choose coordinates that remove genuine degrees of freedom, use directed angles
where orientation matters, and handle collinearity or tangency degeneracies.
Try auxiliary intersections, reflections, power of a point, spiral similarity,
rotation, inversion, and cyclic quadrilaterals. Check whether a construction is
well-defined and whether intersections or divisions vanish. A diagram is not
a proof that a point lies on the required side or that a configuration exists.

## Recurrences and bounded exploration

For polynomial recurrences of degree at least two, values may grow extremely
quickly; do not assume exact enumeration is feasible or that every such
recurrence grows. Track residues modulo a useful prime power, valuations,
monotonicity or inequalities instead. A bounded Bun/TypeScript calculation can
reject a false identity or test a candidate counterexample. Record the actual
scope and exact arithmetic assumptions, and derive a symbolic argument for any
unrestricted conclusion. Do not convert a fitted pattern into a theorem.

## Optimal constructions

Break symmetry deliberately. Compare spreading constraints with clustering
them; a diagonal or constant choice need not optimize the objective. Try a
block construction with parameter `k` when balancing costs of sizes `k` and
`n/k` suggests square-root scale. For distinct vectors with every `k` independent,
the moment curve `(1,t,...,t^(k-1))` at distinct parameters gives a Vandermonde
proof. If using rank-one matrices `v w^T`, prove the particular normalization,
idempotence or commutator identity needed; vector genericity alone does not
supply every claimed matrix property.

An exact optimum needs both a universal bound and a construction attaining it,
including integer rounding and boundary cases. An answer involving a square
root or logarithm does not by itself prove a block construction is optimal.

## When stuck and when finished

If the same case remains open, examine what its hypothesis implies at other
inputs. Try a unified argument that removes the case split, a weaker sufficient
intermediate claim, or a corrected missing statement. Preserve checked partial
results even when changing routes. Distinguish "set aside" from "refuted".

For numeric-answer problems, derive the value and independently check it by
substitution, identities, bounds or a different derivation. Majority agreement
is not an answer check. For find-all problems, prove both admissibility and
exhaustiveness. Finish with [adversarial verification](verification.md), then
[presentation](presentation.md), or with an honest partial result and explicit
remaining obligations when no full solution survives.
