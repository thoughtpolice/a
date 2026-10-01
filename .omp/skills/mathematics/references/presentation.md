<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified adaptation of Anthropic math-olympiad/skills/math-olympiad/references/presentation_prompts.md, Apache-2.0, claude-plugins-official ab024cdc. Direct compiler scripts are not ported. -->

# Presentation after correctness

A presentation pass improves readability, not the level of mathematical
certification. Do not tell an editor that an argument is immune from checking.
A new shortcut, weakened bound, omitted case or altered construction changes
the argument and must be verified again.

- Lead with the exact problem, full theorem and answer, then the idea and details.
- Present in logical order, not discovery order. Remove failed explorations and
  unused checks from the proof; preserve them separately if useful.
- Match machinery to the result. Use a simpler construction or weaker sufficient
  lemma only after proving it works under all assumptions.
- Inline short one-use lemmas when that clarifies the chain. Keep reused or
  structurally important lemmas separate with descriptive names.
- Name meaningful steps and cases. Signpost a reduction with its precise target.
- Display key identities and inequalities; keep routine algebra readable.
- Give exact theorem citations and verified hypotheses. State a contradiction's
  assumption and the contradiction explicitly. State integer rounding and
  equality cases where needed.
- Replace intimidation words such as "trivial" with the actual explanation.
- Retain explicit gaps and Status. Exposition cannot turn a sketch into a proof.

## Optional LaTeX

Markdown mathematics is a valid deliverable. If LaTeX is requested, a compact
`article` document with `amsmath`, `amssymb` and `amsthm`, descriptive theorem
names, and ordinary proof environments suffices. Keep the same precise problem,
full argument and Status in the typeset version. Rendering does not check logic.

The upstream `check_latex.sh` only checks whether `pdflatex` or `xelatex` is on
PATH; it does not validate LaTeX. The upstream `compile_pdf.sh` invokes a system
compiler twice. Neither operation is imported: no compiler is installed or
invoked directly, and there is no pretend PDF implementation or compiler probe.
No LaTeX/tectonic PDF Buck2 target was identified in this repository at migration.

If typesetting becomes available through a real repository target, discover its
actual label and contract with `skill://buck2/query-helper/guide.md` and native Buck2
query tools, inspect its declared sources and outputs, and build/run only that
real target via Buck2. Never invent a target label or wrap an installed external
build system to claim this optional capability exists. If none is available,
provide the requested TeX source and report that PDF typesetting is unavailable.
