<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native helper contracts

All nine native tools accept `{sourceRoot, request, outputRoot, outputName,
overwrite?}`. `sourceRoot` is an explicit real directory (relative to workspace
or absolute); `request` is a JSON file inside it. `outputRoot` stays inside the
OMP workspace and `outputName` is a simple alphanumeric/hyphen/underscore stem.
Files are private, atomically published, and not overwritten by default. Helpers
are imported modules, not command wrappers: no arbitrary exec, package installs,
builds, source execution, hooks, settings or telemetry. Native dependencies are
only standard Node built-ins, compatible with Bun and Deno type checking.

Paths in requests are relative to `sourceRoot`, except explicit `sourceRoot`,
`legacyRoot` and `candidateRoot` sub-roots, which may be absolute or resolve
relative to the request's root. Symlink components, traversal outside a selected
root, nonregular files and broad filesystem/home roots are refused. Ordinary
inputs are capped at 8 MiB; operations add stricter aggregate/count/depth limits.
Walks reject symlinks instead of silently claiming complete coverage, skip known
build/vendor/hidden directories and cap 20,000 entries/40 levels. Immutable source
snapshots include hidden/build files too (but exclude `.git`), cap total 64 MiB,
and fail if incomplete. Keep snapshot/report/evidence outputs outside that source.

## Compare — `modernization_compare`

Request:

```json
{"cases":[{"id":"interest","legacy":"outputs/old.out","candidate":"outputs/new.out","input":"inputs/interest.json","masks":[{"start":20,"end":29,"why":"Timestamp only"}],"tolerance":{"rel":"1e-9","abs":"0","why":"Last-digit library rounding"}}]}
```

`input`, `masks` and `tolerance` are optional. Byte ranges are 0-based inclusive.
Each mask requires a reason and either start/end or `regex`. Regex masks run on
Latin-1 bytes; supported syntax is literals/classes, escaped character classes
(`\d`, `\w`, `\s` and their inverses), escaped punctuation and bounded
`{n}`/`{m,n}` repeats, at most 64 per atom/512 total width. Groups, alternatives,
backreferences, anchors and unbounded repetitions are deliberately rejected to
avoid hostile backtracking; rewrite such masks as explicit bounded spans.
Every hidden span is replaced with one marker; merging preserves positions.

Tolerances are **decimal strings**, nonnegative, at most 1% relative and `1e-6`
absolute (checked exactly); one must be positive and `why` is mandatory.
Comparison uses exact BigInt decimal arithmetic, bounded token length/exponents.
Only tokens containing a decimal point/exponent may vary. Integers, dotted runs
like versions/IPs, and all surrounding text remain exact. Too-long numbers or
unrecognized decimal syntax do not get tolerant success.

Result: `ok`, `oldest` (output/input artifact mtime), and case rows with raw input
and output hashes, same/differs/missing verdict, hidden-byte count, reasons,
masked first-difference offset and self-check. Missing/unreadable outputs stay
missing. All empty outputs and masks hiding everything fail. The self-check
mutates unmasked boundary/middle bytes and sampled leading float digits and
requires at least one free-byte mutation and every sampled leading-digit mutation
to remain detectable; trailing rounding digits may legitimately vary. A passing result remains
only sampled byte equality, not authenticated execution provenance. Up to 500
cases and 64 MiB aggregate. Declared differences are **not** silently approved:
keep human decisions separately and retain the actual differing result.

## Measured baseline — `modernization_baseline`

```json
{"baseline":["baseline.xml"],"fresh":["current.xml"],"crossChecks":[["baseline.log"]],"declared":{"A#test":"PASS"},"flaky":[],"approved":{}}
```

Baseline/fresh paths must name explicit files, not folders. XML/TRX gives per-test
outcomes; `.json` accepts `{testId: "PASS"|"FAIL"|"ERROR"|"SKIP"}` or
`{"tests": <that map>}`. Count-only JSON is refused. `.log`/`.txt`/`.out` must
contain known runner summaries: Maven, Gradle, Cargo, pytest, unittest, Go
verbose/JSON, dotnet, Jest, Vitest, CTest or PHPUnit. Prose success is not evidence.
Do not combine a log and XML of the same tests as separate suites; use
`crossChecks` for alternative complete baseline evidence. Every cross-check must
agree; declared per-test tables are checked against measured results, not used
as the oracle. Evidence conflicts and unknown files fail closed.

JUnit/TRX parser rejects DTDs/entities, unknown outcomes/elements, malformed
nesting, duplicate attributes and malformed UTF-8. It accepts only the documented
runner vocabulary; an unsupported producer must be adapted explicitly, never
heuristically treated as green. XML testcase ids are `class#name`, duplicate
within-file names get `~N` suffixes; overlapping ids across evidence files are
refused rather than overwritten. Empty/no-test evidence cannot pass. XML is
bounded to 60 levels/100,000 cases; up to 100 files/64 MiB aggregate.

Result lists regressions, new failures, still failing/fixed tests, newly skipped
and newly run tests, missing tests/modules, module drops/skip growth, renamed
class tests, flaky flips, declared approvals and evidence conflicts. Class drift
is only renamed when execution/failure/skip counts do not worsen. Approvals
require reasons and must come from actual people, never agent invention; flaky
flips remain gaps. `ok` also requires no missing evidence or execution drop.

## Shard — `modernization_shards`

```json
{"maxFiles":25,"maxLines":5000,"includeTests":false,"pattern":"billing*","topology":{"root":{"kind":"system","children":[{"kind":"domain","name":"Billing","children":[{"kind":"module","name":"Invoice","file":"src/Invoice.ts"}]}]}}}
```

Every field is optional. Topology module locations must be unique readable source
**files**, not directories/aliases. LOC is measured from bytes, never trusted from
model-supplied topology counts. Small same-domain modules merge; large modules
stay separate. Without topology, group source files by directory. Filtering
supports literal component names and narrow `*`/`?` globs. Sort deterministically;
respect both file and LOC caps. An oversized single file fails rather than
truncating or inventing a partial packet. Common legacy/general/web/data source
extensions are recognized; minified, generated/vendor/build and (by default)
test/fixture directories are excluded. Binary files are listed as exclusions.
Result includes shards, measured totals, exclusions and a tiny-estate hint.

## Trace — `modernization_trace`

```json
{"rules":"business-rules.md","modules":[{"name":"billing","path":"candidate/billing","results":["billing.xml"],"notes":"billing-notes.md"}]}
```

Rule cards use `### RULE-001: name`, `**Priority:** P0|P1|P2`, optional confidence
and source fields. Duplicate/unrated cards are rejected. Recognize RULE-017,
RULE_017, rule017, testRule017 and slash/comma shorthand ids. Code and test paths
are scanned read-only without docs/build output. Notes can only claim a rule
when a table row also names an existing module file and is not under a retired/
not-migrated heading. Test-file mentions are marked skipped when their own or
three preceding lines contain disabled/ignore/skip/pending/todo markers.

A passing result whose test/class **name** names a rule is strongest execution
evidence. File mentions require a matching class/file with **all** associated
tests passing and no local skip marker; a partially skipped/failing class cannot
upgrade unrelated mentions. Logs/counts never back rules. Results distinguish
`tested`, `named, not run`, `code only`, `claimed only`, `none`, retain locations,
and identify test-tooling-only modules. Each supplied module is conservatively
responsible for the supplied catalog; narrow catalogs only with genuine scoped
rule evidence, not by dropping unexplained P0 gaps.

## Uplift — `modernization_uplift`

```json
{"legacyRoot":"source","candidateRoot":"candidate","deltas":[{"id":"D-01","category":"Behavioral-silent","sites":["src/Invoice.ts:12"]}]}
```

Compare actual test files using shared test-name/directory conventions. Report
removed/added/changed tests, line additions/removals (bounded exact LCS, explicitly
approximate multiset counts for large inputs), and changed share. Line endings
are normalized. No legacy tests, removed tests, or more than 25% changed tests
are gaps. Test file/aggregate limits prevent partial scans from passing.

For silent deltas, each code site's stem must appear as a **whole word** in test
text. Return covered/uncovered/configuration-only/other ids; unknown/empty catalog
and configuration-only silent deltas remain gaps. A site being named is not a
claim that its changed behavior was exercised. Delta cards are native JSON;
there is no heuristic Markdown ingestion that silently drops malformed cards.

## Snapshot and proof — `modernization_snapshot`, `modernization_proof`

Snapshot request: `{"sourceRoot":"source"}`. Result contains versioned hashes of
all selected source files. Capture before edits; don't hand-type this inventory.

Proof request:

```json
{"track":"rewrite","code":"candidate/billing","sourceRoot":"source","sourceSnapshot":"source-snapshot.json","results":["clean.xml"],"rules":"business-rules.md","development":"development-cases.json","fresh":"fresh-cases.json","canaries":[{"patch":"canary.patch","results":["canary.xml"]}],"brief":"brief.md"}
```

Tracks: rewrite/uplift/rearchitecture. Development and fresh cases use compare
requests; outputs and input files are read and judged again, never loaded from
saved verdicts. Tests and paired outputs must postdate current code. At least
10 distinct fresh **input-byte hashes** count, excluding empty comparisons,
reused development inputs and repeated development legacy output hashes. Ten
output pairs of one input are one input; unlabeled input files never count.

Canary patch must name an existing candidate source file, carry a unified hunk
and exactly one removed/added changed line. Its own measured results must
postdate the patch and show failures beyond clean-run failures. Unknown canary
evidence stays a gap; a detected silent break is a failure. Restore the candidate
and capture a current clean run; the helper requires the removed line to be present
and the added line absent in the restored file. Source immutability is recomputed against the
pre-edit snapshot, never inferred from a model's statement or timestamps alone.

For uplift, `baseline` is a baseline request (fresh is always overridden with
current results), and `uplift` is the uplift request above. They add measured
baseline, kept-tests and silent-delta checks; rule tracing is not applicable.
No result counts typed into proof requests are accepted as evidence.
`PROVEN` means all required checks passed; any fail yields `NOT PROVEN`; gaps
without fails yield `PARTLY PROVEN`. Missing/unknown never upgrades. Unchecked
brief items are listed for the person but don't alter measured verdict. Signoff
is always null. Proof is of supplied artifacts, not cryptographically attested
execution; retain actual run provenance separately.

## Render rules — `modernization_render_rules`

Request: `{system, confirmedRules, dataObjects?, rejectedRules?, unverifiedRules?,
foldedRules?, coverageGaps?, injectionFlags?}`. Rules require name, category,
priority, confidence, source citation, plainEnglish, given, when, then; optional
and/parameters/edgeCases/suspectedDefect/smeQuestion. Data objects require name,
source and fields `{name,type,note?}`, optional consumedBy. The renderer sorts by
category/priority/source, numbers cards, splits primary/additional citations,
includes confirmation questions and all supplied rejected/unverified/folded/gap
information. Values are escaped inert Markdown; rendering never asserts review
or SME approval. Output: `<name>-rules.md`, `<name>-data-objects.md`.

## Report — `modernization_report`

```json
{"system":"Billing","artifacts":[{"title":"Assessment","path":"assessment.md","stage":"assess"}],"topology":"topology.json","proofRequest":"proof-request.json"}
```

Report aggregates explicit artifacts with warnings for missing/refused files;
excludes any `.local.`/`SECRETS` component, caps 3 MiB per artifact/6 MiB total,
shows rule priority/confirmation summaries, validated topology nodes/edges/flows,
and **recomputes** proof from a request. Saved counts/verdicts never establish
proof. Self-contained static HTML escapes all data and uses `default-src 'none'`
CSP; it has no script, external images/requests, active source links or forms.
Markdown is escaped too. No minified viewer or Mermaid JS is bundled: diagrams
remain auditable source. Output: `<name>.html`, `<name>.md`. Next-stage hints are
artifact inventory hints, not claims of completion or approval.

## Representative smoke scenarios

After integration, use the repository's Buck2 testing workflow for both
`modernization*_test.ts` files; no standalone third-party scripts are needed.
For a live smoke, create a scratch candidate exporting a threshold predicate and
invoke it with permitted Bun/Buck2 runtime, retaining actual output files and a
clean runner artifact. Capture a source snapshot outside that source. Compare
one matching development case plus ten distinct fresh inputs/outputs, trace a
P0-named passing test, deliberately change the threshold by one in the scratch
candidate and retain its one-line patch and real failing results, restore it and
capture the clean run. Invoke `modernization_proof` and open the generated report.
Exercise failure variants: blank outputs, all-byte mask, changed unmasked amount,
integer/version drift under tolerance, all-skipped/no-tests XML, missing oracle,
unknown XML element/DTD, reused input hash, undetected canary, mutated source,
removed test and silent site with only a substring mention. The verdict must
fail/gap, never become PROVEN from a claimed count or approval.
