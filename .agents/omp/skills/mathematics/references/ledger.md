<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified adaptation of Anthropic math-proof/skills/siege/scripts/ledger.py and skills/siege/SKILL.md, Apache-2.0, claude-plugins-official ab024cdc. -->

# Native proof ledger contract

Use an existing run directory under the current workspace. Paths may not escape
it, and symlink components and symlink artifacts are rejected. Inputs are bounded
regular UTF-8 files (at most 8 MiB each). Use one bookkeeping writer; call it only
after workers have stopped writing their artifacts. Calls in one tool process
are serialized; this is not a distributed filesystem transaction manager.

The module exposes the Bun-compatible TypeScript helper `proofLedger(cwd,
request)` and two native tools. It runs no subprocess, Python, or build system.
All results are structured objects with `verdict`; `ERROR` is never success.
Malformed parameters, stems, ledger text, state or output paths are preflighted
before any artifact is mutated. An I/O interruption can leave already published
individual artifacts; preserve them and inspect the failure, never infer success.

## Files and statuses

For round `R` (positive integer), write:

- `roundR_summary.md`: nonempty running summary.
- `roundR_ledger_block.md`: this round's new claims, one per line; it may be empty
  or absent when no new claim arose.
- Either `roundR_q1.md`, `roundR_q2.md`, ... for questions, or a nonempty
  `roundR_DONE.md` naming the claimed resolution. Existing questions take
  precedence over DONE.

Block entries look like:

```text
OPEN: [GOAL] Every admissible object has property P — round1_plan
OPEN: [CRITICAL] The remaining universal lemma — round1_plan
PROVED: [CRITICAL] The lemma holds — round1_q1
RETRACT 2: replaced by the proved claim in entry 3
PROVED: [GOAL] Property P follows using entry 3 — round1_q2
PROVED: [AUDIT] The complete argument for entry 5 checks — round1_q3
PROVED: [AUDIT] The chain for entry 5 checks independently — round1_q4
```

The helper adds consecutive numeric IDs; a block's bullets or self-assigned IDs
are stripped. Tags count only immediately before or after the status word, not
inside prose. Allowed statuses are OPEN, SKETCHED, PROVED, REFUTED and RETRACT
(RETRACTED is accepted). A retraction names an earlier non-retraction entry and
gives a reason. It removes that claim from force; it does not renumber history.
Cite IDs as `entry 12`, `#12`, `claim 12`, or `line 12`. A prose `L12`, a decimal
reference such as `Claim 2.4`, or a bare integer is not a ledger citation.
Every support dependency must be cited explicitly; the helper cannot discover
an omitted mathematical premise. A settled claim ends with `— query_stem`,
naming its complete answer artifact. Plan locators on OPEN entries are not
certifications.

## append (write approval)

Call `proof_ledger` with `{operation:"append", directory, round:R}`. It writes
`roundR_ledger.md` and rebuilds `ledger.md` from numeric round order, not lexical
order. Repeating the same append preserves numbering and returns APPENDED.
Committed rounds are immutable; changed content must be recorded in a later
round. Inserting an earlier round after later ones is rejected to prevent stale
IDs and corrupt cross-round support. A pending block is fully validated before
publication.

## gate (read approval)

Call `proof_ledger_gate` with `{directory}` for committed parts or
`{directory,round:R}` for earlier parts plus R's pending block. It never writes
files or classifies/moves answers. It returns CONCLUDE or REJECT, or ERROR for
malformed input. CONCLUDE requires:

1. The newest live `[GOAL]` is PROVED or REFUTED. A later OPEN/SKETCHED goal
   supersedes a previously settled one.
2. Every explicitly cited transitive support entry exists, is live and PROVED,
   is not an audit, has a finished-answer locator, and participates in an
   acyclic chain. A REFUTED goal is an attested disproof, not permission to rely
   on refuted support premises.
3. Every live `[CRITICAL]` obligation belongs to that settled support chain.
   Retract an obsolete formulation explicitly; do not drop it from the goal's
   citations to hide an open obligation.
4. Two live PROVED `[AUDIT]` lines from distinct finished query locators certify
   that exact chain, each citing its IDs and at least one citing the current
   goal itself. The goal is not its own audit, duplicated lines count once,
   missing/partial answer locators do not count, and stale or unrelated cited
   IDs do not qualify an audit.

A locator is a terminal stem (optionally `.answer.md`) after the final dash;
its matching answer file must carry its own terminal marker. A filename's mere
existence is insufficient. This validates recorded attestations and dependency
shape only; it does not read the mathematical argument for correctness or prove
that reviews were genuinely independent. Replacing an answer under the same
stem does not magically reverify it: use a new stem and new ledger entries when
the underlying proof changes.

## answers (write approval)

Call `proof_ledger` with `{operation:"answers",directory,stems:["round1_q1",...]}`.
Stems contain only ASCII letters, digits and underscores; filename suffixes
`.md`, `.answer.md`, `.partial.md`, `.noanswer.md` are accepted. Paths and malformed
stems are rejected for the entire batch before changes. Each stem must have a
query, answer, partial or valid no-answer provenance artifact. Duplicate stems are
classified once; a never-existing stem remains an error.

A finished writer puts `=== END OF ANSWER round1_q1 ===` on its last meaningful
line, even when the mathematical outcome is partial or negative. Case,
Markdown dressing, escaped underscores and a path ending in the right filename
are tolerated. A checklist, another query's marker, prose mentioning a marker,
or substantive text after it is not terminal. Blank lines, closing code fences
and bare markup closing tags do not hide a preceding marker.

The result distinguishes `answered`, `partial`, and `no answer` and gives totals.
An unfinished nonempty `.answer.md` becomes `.partial.md`. Of two unfinished
answers, retain the longer nonempty one there and the other in `.partial.prev.md`;
only an older `.partial.prev.md` may be overwritten. Remove an empty `.answer.md`
after preserving its provenance in a zero-byte `.noanswer.md` marker. An existing
marker must be a whitespace-only regular file and is never overwritten; marker
targets are validated for the entire batch before any mutation. This marker lets
an answer-only empty stem classify as `no answer` again even without a query file.
Finished answers and nonempty partial material take precedence over that marker
and are otherwise left untouched. The marker is bookkeeping only, never a
completed proof locator. Repeating classification is idempotent, including mixed
batches with new answers. "Answered" means the writer finished—not that the
mathematics was solved.

## check (write approval)

Call `proof_ledger` with `{operation:"check",directory,round:R,wave:4,minRounds:4,
attempt:1}`. `wave` is a positive cap and `minRounds` is nonnegative; the optional
attempt is 1–3, default 1. It persists effective attempts and terminal outcomes
in `judge/plan_rR_state.json`. Repeated `attempt:1` still reaches attempt 3;
changing wave/minRounds or malformed persisted state is rejected, not reset.
Do not edit/delete state to bypass the bound. Repeating a terminal check returns
its recorded outcome instead of relaunching work.

- **WAVE:** active questions are numbered consecutively, withdrawn questions
  moved to `.withdrawn.md`, excess questions to `.overcount.md`, and a competing
  DONE to `.superseded.md`. At least half, rounded up, must declare `kind: attempt`
  or `kind: attack` in their first three nonempty alphabetic lines. The result
  names the query stems and `floor = max(1,floor(3*n/10))`. Classify every wave
  answer before applying that floor; if too little substantive material returns,
  preserve work and report the actual issue rather than claiming progress.
- **CONCLUDE:** a nonempty DONE and the full gate qualify. `minRounds` changes
  only whether this is described as early conclusion; it never bypasses the gate.
- **RETRY:** missing summary, insufficient attempt queries, missing plan shape,
  or an unqualified DONE gets a correction. Its block is not committed. Queries
  can be replanned; rejected DONE is preserved as `.rejectedN.md`.
- **TAIL:** after three valid checks, an unresolved planning problem ends the
  round without claiming the goal proved. Unlike the source script, exhaustion
  never accepts an unaudited conclusion or an under-quota wave.

Terminal WAVE/CONCLUDE/TAIL commits the validated block when a nonempty summary
exists. Missing-summary TAIL preserves material without pretending it was a
valid plan. Renumbering refuses queries with answer artifacts, including
`.noanswer.md` provenance; archive collisions are errors, not silent overwrites.
An ERROR is a malformed/unprocessable request,
not a retryable mathematical verdict: correct the actual artifact/path issue
before proceeding. The bookkeeping tool never launches agents or writes proofs.
