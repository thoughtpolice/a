---
name: mathematics
description: Solve or verify mathematical problems rigorously, including olympiad and competition proofs, hard solo proofs, counterexamples, collaborative proof obligations, and self-contained mathematical presentation. Use when asked to prove or disprove a claim, find all solutions or an extremum, check a proof for gaps, or organize a sustained mathematical investigation.
---

<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified adaptation of Anthropic's Apache-2.0 math-proof and math-olympiad plugins, claude-plugins-official revision ab024cdc. -->

# Rigorous mathematics

Produce an argument for the exact question, not a plausible answer to an easier
one. Bookkeeping, agreement between agents, examples, and successful typesetting
are not proof-validity checks.

## Choose the workflow

- A single focused proof: read [solo proof](references/solo.md).
- A hard problem with genuinely independent substantial obligations or attacks:
  read [collaborative proof](references/collaboration.md). Repository task,
  scout, and reviewer delegation gates prevail; do not create a fixed fanout.
- A competition problem, numeric answer, construction, or stalled approach:
  read [problem-solving heuristics](references/problem-solving.md).
- A proposed proof or candidate solution: read
  [adversarial verification](references/verification.md).
- A settled argument ready for exposition: read
  [presentation](references/presentation.md). Recheck logical changes.

## Preserve the problem before solving

1. Preserve the complete supplied problem verbatim in `problem.md` when a run
   directory is useful. Separate any interpretation notes from that text.
2. Enumerate the domain, quantifiers, allowed degeneracies, assumptions, and the
   requested output: one witness versus all solutions, an upper bound versus an
   exact optimum, necessity versus sufficiency, proof versus disproof.
3. List materially different readings. Do not decide that the harder reading is
   automatically intended; resolve it from the actual wording and context. Ask
   only if a material ambiguity remains. State the reading being solved.
4. On resume, compare the existing problem and assumptions before reusing work.
   Do not overwrite a directory holding a different problem. Read recorded
   claims, gaps, and the latest draft rather than reconstructing them from memory.

## Common completion contract

A final `proof.md` must stand alone: state the problem and assumptions, give the
answer and every relied-on argument, and distinguish established results from
conjectures or sketches. Cite external theorems precisely and verify their
hypotheses; if recalled from memory, say so and do not invent a reference.
Never substitute a reference to a run's notes, ledger, query, or answer files
for a lemma's proof.

Keep a **Status** section saying whether the posed question is fully resolved,
what partial results are proved, and the exact unresolved obligations. Mark a
remaining gap at the point where the chain needs it, not only in the status.
Counterexamples must satisfy every original assumption and actually negate the
claimed conclusion. A correct numeric answer from invalid reasoning is not a
solution. If no full argument survives checking, report that honestly along
with the useful proven material; do not guess.

## Native bookkeeping

`proof_ledger` implements `append`, `answers`, and `check` with write approval.
`proof_ledger_gate` is a read-only inspection. Discover their structured schemas
through the native tool interface; there is no Python script or shell wrapper.
Read [the ledger contract](references/ledger.md) before using a round ledger.
The helper preserves unfinished answers, numbers committed rounds idempotently,
and bounds planning retries. Its conclusion means only that the recorded
attestations meet the mechanical gate—not that the mathematics is correct.
