<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Source and modification map

Source: [Anthropic claude-plugins-official/code-modernization](https://github.com/anthropics/claude-plugins-official/tree/ab024cdc/plugins/code-modernization),
revision `ab024cdc`, Apache-2.0 as declared in the plugin's `LICENSE`.
All adaptations are modified, OMP-native implementations. Repository root
Apache-2.0 license covers these derivatives; no redundant license copy is added.
The inspected source files carry no additional specific copyright/NOTICE text.

## Portable algorithms reimplemented

| Exact upstream path below `plugins/code-modernization/` | Native destination | Retained behavior and deliberate change |
|---|---|---|
| `scripts/compare.py` | `scripts/compare.ts` | Byte comparisons, merged reasoned masks, exact decimal tolerances, first difference, raw hashes, empty/missing refusal, mutation self-check. Bounded regex subset avoids hostile backtracking; raw differences remain failures rather than generating human approval claims. |
| `scripts/baseline_diff.py` | `scripts/baseline_diff.ts`, `scripts/evidence.ts` | JUnit/TRX, per-test JSON and recognized runner logs, source conflicts, measured/declaration checking, regressions/new/still-failing/fixed/skipped/missing/renamed/module drops. Explicit native JSON/file lists replace heuristic Claude artifact/Markdown discovery; unknown XML/status/evidence fails closed. |
| `scripts/make_shards.py` | `scripts/make_shards.ts` | Tree/topology sharding, extension/exclusion filtering, domain small-module pooling, measured LOC, deterministic pattern selection, bounds and tiny-estate hint. Duplicate topology locations, symlinks and oversized files are explicit errors, not silent fallback/omission. |
| `scripts/trace_rules.py` | `scripts/trace_rules.ts`, `scripts/common.ts` | Rule cards/id shorthand, code/test/notes claims, local skip markers, executed passing names, matching class/file evidence, per-module locations and tooling-only identification. Mixed skipped/failing classes cannot upgrade unrelated mentions; missing priorities fail closed. |
| `scripts/uplift_checks.py` | `scripts/uplift_checks.ts` | Kept-test additions/removals/edits, normalized line endings, bounded line deltas with explicit approximation, 25% threshold, whole-word silent-site mentions/config exceptions. Native delta JSON replaces tolerant Markdown scraping; configuration-only silent evidence stays a gap. |
| `scripts/proof_pack.py` | `scripts/proof_pack.ts` | Current tests/freshness, rule execution, rejudged development/fresh comparisons, ten distinct fresh inputs, measured failing canary, source immutability, uplift's baseline/kept/delta checks, human criteria separate, unknown never upgraded. SHA-256 source inventory strengthens timestamp-only checks; actual input hashes replace model labels/counts; approval/signoff remain unclaimed. |
| `scripts/build_report.py` | `scripts/build_report.ts` | Safe bounded artifact aggregation/exclusions, warnings, rule/topology summaries, next-stage inventory hints, current proof recomputation, self-contained offline HTML and Markdown. Static escaped presentation replaces minified browser libraries, active links and Claude command conventions. |
| `scripts/render_rules.py` | `scripts/render_rules.ts` | Category/priority/source sorting and numbering, source/additional citation split, rule cards, domain-owner questions, rejected/unverified/folded/gap/injection sections, typed data-object tables. Does not repeat upstream's unconditional assertion that referees checked all citations. |

Shared safe file I/O uses the repository's existing `.omp/lib/files.ts`; native
factories live in `.omp/tools/modernization.ts`. No upstream Python is shipped
or executed. Tests are newly authored consumer boundary regressions, not copied
upstream source-text or runtime-wiring tests.

## Workflow guidance adapted

Exact upstream command sources used for the native staged guide:

- `commands/modernize-preflight.md`: source/target readiness, CI/toolchain evidence,
  source completeness, two-way scope crossing, read-only source.
- `commands/modernize-assess.md`: single-system/portfolio inventory, consistent
  complexity measurements, relative-scale formula, debt/security/docs and track
  selection; telemetry code is not retained.
- `commands/modernize-map.md`: code/config joins, dynamic dispatch/entry points,
  topology ids/edges, dead-code caveats and persona flows.
- `commands/modernize-extract-rules.md`: extraction lenses, primary citations,
  adversarial checking, rule cards/priorities and visible coverage gaps.
- `commands/modernize-review.md`: preserve actual domain-owner rule decisions,
  wrong/discuss rule exclusions and unresolved P0 decisions.
- `commands/modernize-brief.md`: constrained phased plan, behavior contract,
  harness/shared-consumer overrides, representative pilot and actual approval.
- `commands/modernize-uplift.md`: exact hops, isolated copy, measured baseline,
  code-intersected deltas, pilot/playbook, dependency order and outcome triage.
- `commands/modernize-transform.md`: vertical slice, characterization tests,
  idiomatic implementation, measured comparisons, canary and trace mapping.
- `commands/modernize-reimagine.md`: capabilities/interfaces, material decisions,
  architecture critique, migration and per-service acceptance. Stub/scaffold
  completion conventions are intentionally not retained.
- `commands/modernize-harden.md`: evidence/refutation, coverage gaps, credential
  hygiene, targeted candidate remediation and review of new risks.
- `commands/modernize-status.md`: artifact inventory, stale dependencies,
  pending/failed/blocked units, proof-before-completion and next blocking action.

## Explicit exclusions

No code, bundles, assets, tests, hooks or declarations are copied from these
upstream paths:

- `scripts/telemetry.py`, `scripts/telemetry.sh`: excluded in full; no telemetry.
- `hooks/**`: all Claude hooks, settings, mount/register/pane/state glue, signed
  process transport and in-process pane bundles excluded in full.
- `workflows/**`: all Workflow engine/model-specific fanout, journaling, cache,
  model tiers, runtime minified bundles and process invocation excluded in full.
  `workflows/extract-rules.js` was inspected for adversarial citation/refutation
  behavior but none of its implementation is ported.
- `assets/**`: minified/vendor JS, media, report-template and topology-viewer
  bundles excluded; native reports are escaped static documents.
- `.claude-plugin/**`, `agents/**`: registration/model/provider role declarations
  excluded; native guide uses repository delegation rules instead.
- `tests/**`, `scripts/tests/**`, `tsconfig.json`: upstream test/runtime/build
  scaffolding excluded; native tests follow the repository's Deno/Buck2 setup.
- `commands/modernize.md`, `commands/modernize-verify.md`: Claude invocation and
  destructive clean/run conventions not imported; native workflow/proof contract
  substitutes repository-governed Buck2 execution and measured evidence inputs.
- Upstream README/CHANGELOG are context only, not copied documentation.

No source from `plugins/claude-security` or proprietary document skills is used.
No proprietary source is inspected or executed. Imported third-party trees are
read-only throughout this port.
