// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare } from "../skills/modernization/scripts/compare.ts";
import { baselineDiff } from "../skills/modernization/scripts/baseline_diff.ts";
import { parseLog, parseXML, readEvidence } from "../skills/modernization/scripts/evidence.ts";
import { makeShards } from "../skills/modernization/scripts/make_shards.ts";
import { traceRules } from "../skills/modernization/scripts/trace_rules.ts";
import { lineDiff, upliftChecks } from "../skills/modernization/scripts/uplift_checks.ts";
import { proofPack, snapshot } from "../skills/modernization/scripts/proof_pack.ts";
import { renderRules } from "../skills/modernization/scripts/render_rules.ts";
import { buildReport } from "../skills/modernization/scripts/build_report.ts";
function assert(value: unknown, why: string): asserts value { if (!value) throw new Error(why); }
async function rejects(action: () => unknown | Promise<unknown>): Promise<void> {
  try { await action(); } catch (error) { assert(error instanceof Error, "Expected an input/evidence error"); return; }
  throw new Error("Unsafe or unrecognized input was accepted");
}
async function fixture(action: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "omp-modernization-"));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}
Deno.test("equivalence requires observable nonempty output, detects first differing bytes and refuses missing oracles", () => fixture(async root => {
  await writeFile(join(root, "old"), "amount=9.00\n"); await writeFile(join(root, "new"), "amount=9.00\n");
  const spec = { cases: [{ id: "interest", legacy: "old", candidate: "new" }] };
  assert((await compare(root, spec)).ok, "Equal real output rejected");
  await writeFile(join(root, "new"), "amount=8.00\n");
  const diff = await compare(root, spec); assert(!diff.ok && diff.cases[0].firstDifference === 7, "Real changed amount hidden");
  await writeFile(join(root, "old"), ""); await writeFile(join(root, "new"), "");
  assert(!(await compare(root, spec)).ok, "Empty outputs proved behavior");
  assert((await compare(root, { cases: [{ id: "missing", legacy: "absent", candidate: "new" }] })).cases[0].verdict === "missing", "Missing oracle did not fail closed");
}));
Deno.test("reasoned byte and bounded regex masks cannot make the comparator tautological", () => fixture(async root => {
  await writeFile(join(root, "old"), "rate=4 time=2024-01-01\n"); await writeFile(join(root, "new"), "rate=4 time=2025-12-31\n");
  const c = { id: "clock", legacy: "old", candidate: "new", masks: [{ regex: "\\d{4}-\\d{2}-\\d{2}", why: "Wall clock date varies" }] };
  assert((await compare(root, { cases: [c] })).ok, "Legitimate timestamp mask rejected");
  await writeFile(join(root, "new"), "rate=5 time=2025-12-31\n"); assert(!(await compare(root, { cases: [c] })).ok, "Unmasked rate changed without failure");
  const hidden = await compare(root, { cases: [{ ...c, masks: [{ start: 0, end: 100, why: "everything" }] }] });
  assert(!hidden.ok && !hidden.cases[0].selfCheck, "All-output mask passed canary");
  await rejects(() => compare(root, { cases: [{ ...c, masks: [{ regex: "(a+)+$", why: "Hostile backtracking" }] }] }));
  await rejects(() => compare(root, { cases: [{ ...c, masks: [{ start: 1, end: 2 }] }] }));
}));
Deno.test("decimal tolerance is exact, bounded, and cannot hide integers, dotted identifiers, text or leading-digit breaks", () => fixture(async root => {
  const c = { id: "rounding", legacy: "old", candidate: "new", tolerance: { rel: "1e-9", why: "Last-digit library rounding" } };
  await writeFile(join(root, "old"), "value=1.0000000000\n"); await writeFile(join(root, "new"), "value=1.0000000001\n");
  assert((await compare(root, { cases: [c] })).ok, "Legitimate float rounding rejected");
  await writeFile(join(root, "old"), "1.0000000000000000000"); await writeFile(join(root, "new"), "1.0000000001000000000");
  assert((await compare(root, { cases: [c] })).ok, "Legitimate trailing-digit tolerance made the canary tautological");
  for (const [a, b] of [["1", "2"], ["version=1.2.3", "version=1.2.4"], ["value=1.0 A", "value=1.0 B"], ["1.0", "2.0"], ["1.000000000000000000000000000000", "1.000000000000000000000000000001"]]) {
    await writeFile(join(root, "old"), a); await writeFile(join(root, "new"), b);
    const tolerance = a.length > 20 ? { rel: "1e-32", why: "Tighter than change" } : c.tolerance;
    assert(!(await compare(root, { cases: [{ ...c, tolerance }] })).ok, `Real difference hidden: ${a}`);
  }
  for (const tolerance of [{ rel: "0.010000000000000000001", why: "Too broad" }, { abs: "0.000001000000000000001", why: "Too broad" }, { rel: "1e-9" }]) await rejects(() => compare(root, { cases: [{ ...c, tolerance }] }));
}));
Deno.test("XML rejects DTD, entities, malformed/unrecognized data and unknown outcomes", async () => {
  for (const xml of ['<!DOCTYPE testsuite [<!ENTITY x "y">]><testsuite/>', '<testsuite><testcase name="x">&unknown;</testcase></testsuite>', '<testsuite><testcase name="x"></testsuite>', '<banana><testcase name="x"/></banana>', '<testsuite><testcase name="x"><new-outcome/></testcase></testsuite>', '<TestRun><Results><UnitTestResult testName="A.x" outcome="Banana"/></Results></TestRun>', '<testsuite><testcase name="x" status="Banana"/></testsuite>']) await rejects(() => parseXML(xml));
  for (const xml of ['<testsuite><testcase name="x">&constructor;</testcase></testsuite>', '<TestRun><Results><UnitTestResult testName="A.x" outcome="constructor"/></Results></TestRun>', '<testsuite><properties><testcase name="x"/></properties></testsuite>']) await rejects(() => parseXML(xml));
  await rejects(() => parseXML('<testsuite tests="2" failures="1"><testcase name="optimistic"/></testsuite>'));
  const cases = parseXML('<testsuite name="A"><testcase name="one"/><testcase name="one"><failure message="bad"/></testcase><testcase name="two"><skipped message="No platform"/></testcase></testsuite>');
  assert(cases[0].id === "A#one" && cases[1].id === "A#one~1" && cases[1].outcome === "FAIL" && cases[2].outcome === "SKIP" && cases[2].reason === "No platform", "Per-test outcomes not preserved");
  const trx = parseXML('<TestRun><Results><UnitTestResult testName="A.one" outcome="Passed"/><UnitTestResult testName="A.two" outcome="Failed"/></Results></TestRun>');
  assert(trx[0].id === "A#one" && trx[1].outcome === "FAIL", "TRX evidence misread");
});
Deno.test("recognized raw runner summaries are evidence, typed totals and optimistic prose are not", async () => {
  for (const [log, executed, failed, skipped] of [["test result: ok. 3 passed; 1 failed; 2 ignored;", 4, 1, 2], ["[INFO] Tests run: 9, Failures: 1, Errors: 1, Skipped: 2", 7, 2, 2], ["=== 3 passed, 1 skipped in 0.10s ===", 3, 0, 1], ["Ran 3 tests in 0.1s\nFAILED (failures=1, skipped=1)", 2, 1, 1], ["Tests: 1 failed, 2 passed, 3 total", 3, 1, 0]] as const) {
    const counts = parseLog(log); assert(counts.executed === executed && counts.failed === failed && counts.skipped === skipped, `Runner summary misread: ${log}`);
  }
  await rejects(() => parseLog("All tests passed. Executed: 50"));
  await fixture(async root => { await writeFile(join(root, "typed.json"), '{"PASS":50,"FAIL":0}'); await rejects(() => readEvidence(root, ["typed.json"])); });
  await fixture(async root => {
    await writeFile(join(root, "invalid.json"), new Uint8Array([123, 34, 65, 255, 34, 58, 34, 80, 65, 83, 83, 34, 125]));
    await rejects(() => readEvidence(root, ["invalid.json"]));
  });
});
Deno.test("measured baseline detects no-tests, regression, missing modules, skips and conflicting sources", () => fixture(async root => {
  await writeFile(join(root, "old.json"), JSON.stringify({ "A#keep": "PASS", "A#skip": "PASS", "B#lost": "PASS", "A#known": "FAIL" }));
  await writeFile(join(root, "new.json"), JSON.stringify({ "A#keep": "FAIL", "A#skip": "SKIP", "A#known": "FAIL", "C#new": "FAIL" }));
  const report = await baselineDiff(root, { baseline: ["old.json"], fresh: ["new.json"] });
  assert(report.fail && report.regressions.includes("A#keep") && report.newFailures.includes("C#new") && report.newlySkipped.includes("A#skip") && report.missingModules.includes("B") && report.stillFailing.includes("A#known"), "Baseline gaps lost");
  await writeFile(join(root, "empty.xml"), '<testsuite name="none"/>'); assert(!(await baselineDiff(root, { baseline: ["old.json"], fresh: ["empty.xml"] })).ok, "No-test uplift passed");
  await writeFile(join(root, "alternate.json"), '{"A#keep":"FAIL"}');
  const conflict = await baselineDiff(root, { baseline: ["old.json"], fresh: ["old.json"], crossChecks: [["alternate.json"]] }); assert(conflict.gap && conflict.conflicts.length > 0, "Disagreeing baselines accepted");
  const typed = await baselineDiff(root, { baseline: ["old.json"], fresh: ["old.json"], declared: { "A#keep": "FAIL" } }); assert(!typed.ok, "Typed declaration overrode measured results");
}));
Deno.test("baseline distinguishes fixes and safe class name drift without blessing missing modules", () => fixture(async root => {
  await writeFile(join(root, "old.json"), '{"A#oldParameter":"PASS","B#fixed":"FAIL","B#run":"SKIP"}');
  await writeFile(join(root, "new.json"), '{"A#newParameter":"PASS","B#fixed":"PASS","B#run":"PASS"}');
  const report = await baselineDiff(root, { baseline: ["old.json"], fresh: ["new.json"] });
  assert(report.ok && report.renamed.includes("A#oldParameter") && report.fixed.includes("B#fixed") && report.newlyRun.includes("B#run"), "Legitimate outcome transitions lost");
}));
Deno.test("rule trace never equates named, skipped or unexecuted rules with passing run evidence", () => fixture(async root => {
  await mkdir(join(root, "candidate", "tests"), { recursive: true });
  await writeFile(join(root, "rules.md"), '### RULE-001: money\n**Priority:** P0\n### RULE-002: permission\n**Priority:** P0\n');
  await writeFile(join(root, "candidate", "main.ts"), '// RULE-001 and RULE-002\n');
  await writeFile(join(root, "candidate", "tests", "PolicyTest.ts"), '// skip\n// RULE-001\n\n\n\n// RULE-002\n');
  await writeFile(join(root, "results.json"), '{"PolicyTest#unrelated":"PASS","PolicyTest#RULE-001_skipped":"SKIP"}');
  const named = await traceRules(root, { rules: "rules.md", modules: [{ name: "policy", path: "candidate", results: ["results.json"] }] });
  assert(!named.ok && named.rules.every(r => r.status === "named, not run"), "Skipped or unproven file mention became tested");
  await writeFile(join(root, "results.json"), '{"PolicyTest#RULE-002_permission":"PASS","PolicyTest#RULE-001_skipped":"SKIP"}');
  const run = await traceRules(root, { rules: "rules.md", modules: [{ name: "policy", path: "candidate", results: ["results.json"] }] });
  assert(run.rules[0].status === "named, not run" && run.rules[1].status === "tested", "Executed rule-name evidence not distinguished");
}));
Deno.test("shards honor deterministic file/LOC caps and reject oversized files, topology aliases and source links", () => fixture(async root => {
  await mkdir(join(root, "domain")); for (const name of ["c.ts", "a.ts", "b.ts"]) await writeFile(join(root, "domain", name), "first\nsecond\n");
  const shards = await makeShards(root, { maxFiles: 2, maxLines: 4 });
  assert(shards.shards[0].files.join(",") === "domain/a.ts,domain/b.ts" && shards.shards[1].files[0] === "domain/c.ts", "Sharding order/bounds unstable");
  await rejects(() => makeShards(root, { maxLines: 1 }));
  await rejects(() => makeShards(root, { topology: { root: { kind: "system", children: [{ kind: "module", name: "a", file: "domain/a.ts" }, { kind: "module", name: "b", file: "domain/a.ts" }] } } }));
  await symlink(join(root, "domain", "a.ts"), join(root, "domain", "alias.ts")); await rejects(() => makeShards(root, {}));
}));
Deno.test("uplift rejects removed tests, excessive edits, absent tests and unnamed/config-only silent deltas", () => fixture(async root => {
  const old = join(root, "old"), candidate = join(root, "candidate"); await mkdir(old); await mkdir(candidate);
  for (const dir of [old, candidate]) for (const name of ["a_test.ts", "b_test.ts", "c_test.ts", "d_test.ts"]) await writeFile(join(dir, name), "test Invoice\n");
  const spec = { legacyRoot: old, candidateRoot: candidate, deltas: [{ id: "D1", category: "Behavioral-silent", sites: ["Invoice.ts:1"] }] };
  assert((await upliftChecks(root, spec)).ok, "Unchanged tests with named silent sites rejected");
  await writeFile(join(candidate, "a_test.ts"), "changed Invoice\n"); assert((await upliftChecks(root, spec)).testsKept.ok, "Exactly 25% changed should be allowed");
  await writeFile(join(candidate, "b_test.ts"), "changed Invoice\n"); assert(!(await upliftChecks(root, spec)).testsKept.ok, "More than 25% changed tests allowed");
  const silent = await upliftChecks(root, { ...spec, deltas: [{ id: "D2", category: "Behavioral-silent", sites: ["NotInvoice.ts:1"] }, { id: "D3", category: "Behavioral-silent", sites: ["settings.json:1"] }] });
  assert(!silent.deltas.ok && silent.deltas.uncovered[0].missing[0] === "NotInvoice" && silent.deltas.config.includes("D3"), "Whole-word/config delta gap hidden");
  const diff = lineDiff(["a", "b"], ["a", "c", "d"]); assert(diff.exact && diff.added === 2 && diff.removed === 1, "Line delta count wrong");
}));
Deno.test("proof recomputes current evidence and never upgrades unknown, stale or typed evidence", () => fixture(async root => {
  await mkdir(join(root, "candidate")); await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "original.ts"), "original\n"); await writeFile(join(root, "candidate", "main.ts"), "candidate\n");
  await writeFile(join(root, "snapshot.json"), JSON.stringify(await snapshot(join(root, "source"))));
  const basic = { track: "rewrite", code: "candidate", sourceRoot: "source", sourceSnapshot: "snapshot.json" };
  const gap = await proofPack(root, basic); assert(gap.verdict === "PARTLY PROVEN" && gap.checks.find(c => c.id === "source")?.state === "pass", "Missing evidence became proven");
  await writeFile(join(root, "results.json"), '{"A#works":"PASS"}'); await utimes(join(root, "results.json"), 1, 1);
  const stale = await proofPack(root, { ...basic, results: ["results.json"] }); assert(stale.checks.find(c => c.id === "tests")?.state === "gap", "Stale test run became current");
  await writeFile(join(root, "source", "original.ts"), "mutated\n"); const changed = await proofPack(root, basic); assert(changed.checks.find(c => c.id === "source")?.state === "gap", "Modified source accepted as immutable");
  await writeFile(join(root, "typed.json"), '{"executed":100,"failed":0}'); await rejects(() => proofPack(root, { ...basic, results: ["typed.json"] }));
}));
Deno.test("reports and rules preserve hostile data as inert text and never trust a recorded proof verdict", () => fixture(async root => {
  const attack = '<script>alert("x")</script><img src="https://example.invalid/steal">'; await writeFile(join(root, "artifact.md"), attack);
  await writeFile(join(root, "SECRETS.local.md"), "must not leak"); await writeFile(join(root, "claim.json"), '{"verdict":"PROVEN"}');
  const report = await buildReport(root, { system: attack, artifacts: [{ title: attack, path: "artifact.md" }, { title: "private", path: "SECRETS.local.md" }], proofRequest: "claim.json" });
  assert(report.verdict === "NOT PROVEN" && !report.html.includes("<script>") && !report.html.includes("<img ") && !report.html.includes("must not leak") && report.html.includes("default-src 'none'"), "Unsafe report or claimed verdict trusted");
  const rendered = renderRules({ system: attack, confirmedRules: [{ name: attack, category: "Policy", priority: "P0", confidence: "Low", source: "src/rule.ts:1-2; also src/other.ts:3", plainEnglish: attack, given: "condition", when: "event", then: "effect", smeQuestion: "Is it intentional?" }] });
  assert(!rendered.rules.includes("<script>") && rendered.rules.includes("**Also cited:**") && rendered.rules.includes("RULE-001") && rendered.rules.includes("Is it intentional"), "Rule catalog injects markup or loses review/citation data");
  await writeFile(join(root, "rules.md"), rendered.rules); const trace = await traceRules(root, { rules: "rules.md", modules: [] }); assert(!trace.ok, "Rendered catalog claimed executed rule coverage");
}));
Deno.test("artifact paths cannot escape their selected root or traverse symlinks", () => fixture(async root => {
  await writeFile(join(root, "new"), "safe\n"); await symlink(join(root, "new"), join(root, "linked"));
  for (const legacy of ["../outside", "linked"]) { const compared = await compare(root, { cases: [{ id: "unsafe", legacy, candidate: "new" }] }); assert(!compared.ok && compared.cases[0].verdict === "missing", "Unsafe oracle path accepted"); }
}));
