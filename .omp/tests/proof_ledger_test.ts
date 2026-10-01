// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Tests for the modified Apache-2.0 math-proof ledger port, upstream ab024cdc.

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { citedIds, isFinishedAnswer, proofLedger } from "../tools/proof-ledger.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function withRun(action: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "omp-proof-ledger-test-"));
  try { await action(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function snapshot(root: string): Promise<string> {
  const files: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) { files.push(`${name}/`); await visit(join(directory, entry.name), name + "/"); }
      else if (entry.isSymbolicLink()) files.push(`${name}:symlink`);
      else files.push(`${name}:${(await readFile(join(directory, entry.name))).toString("base64")}`);
    }
  }
  await visit(root, "");
  return files.join("\n");
}
async function answers(root: string, stems: string[]): Promise<void> {
  for (const stem of stems) await writeFile(join(root, `${stem}.answer.md`), `A written mathematical argument.\n=== END OF ANSWER ${stem} ===\n`);
}
async function gateFixture(root: string, block?: string): Promise<void> {
  await answers(root, ["round1_q1", "round1_q2", "round1_q3", "round1_q4"]);
  await writeFile(join(root, "round1_ledger_block.md"), block ?? [
    "PROVED: [CRITICAL] The support lemma — round1_q1",
    "PROVED: [GOAL] The conclusion using entry 1 — round1_q2",
    "PROVED: [AUDIT] The proof of entry 2 checks — round1_q3",
    "PROVED: [AUDIT] The proof of entry 2 checks independently — round1_q4",
  ].join("\n") + "\n");
}

Deno.test("append is idempotent and orders numeric rounds without changing committed IDs", async () => {
  await withRun(async (root) => {
    await writeFile(join(root, "round2_ledger_block.md"), "- OPEN: [GOAL] Main goal — round2_plan\n");
    assert((await proofLedger(root, { operation: "append", directory: ".", round: 2 })).verdict === "APPENDED", "First round append failed");
    await writeFile(join(root, "round10_ledger_block.md"), "L4. OPEN: Another obligation — round10_plan\n");
    assert((await proofLedger(root, { operation: "append", directory: ".", round: 10 })).verdict === "APPENDED", "Later numeric round append failed");
    const expected = "1. OPEN: [GOAL] Main goal — round2_plan\n2. OPEN: Another obligation — round10_plan\n";
    assert(await readFile(join(root, "ledger.md"), "utf8") === expected, "Numeric order or assigned numbering changed");
    const before = await snapshot(root);
    await proofLedger(root, { operation: "append", directory: ".", round: 2 });
    assert(await snapshot(root) === before, "Repeated append altered content");
    await writeFile(join(root, "round2_ledger_block.md"), "OPEN: Changed goal — round2_plan\n");
    const changed = await snapshot(root);
    assert((await proofLedger(root, { operation: "append", directory: ".", round: 2 })).verdict === "ERROR", "Committed round changed in place");
    assert(await snapshot(root) === changed, "Rejected rewrite mutated ledger");
    await writeFile(join(root, "round1_ledger_block.md"), "OPEN: Earlier entry — round1_plan\n");
    const insertion = await snapshot(root);
    assert((await proofLedger(root, { operation: "append", directory: ".", round: 1 })).verdict === "ERROR", "Earlier insertion would stale existing IDs");
    assert(await snapshot(root) === insertion, "Rejected insertion mutated ledger");
  });
});

Deno.test("gate reads a pending settled chain and distinct finished audits without mutation", async () => {
  await withRun(async (root) => {
    await gateFixture(root);
    const before = await snapshot(root);
    assert((await proofLedger(root, { operation: "gate", directory: ".", round: 1 })).verdict === "CONCLUDE", "Complete attested chain rejected");
    assert(await snapshot(root) === before, "Read-only gate changed artifacts");
    await proofLedger(root, { operation: "append", directory: ".", round: 1 });
    assert((await proofLedger(root, { operation: "gate", directory: "." })).verdict === "CONCLUDE", "Committed attested chain rejected");
  });
});

Deno.test("retracted and unsettled critical support cannot conclude despite positive audits", async () => {
  await withRun(async (root) => {
    await gateFixture(root);
    const original = await readFile(join(root, "round1_ledger_block.md"), "utf8");
    for (const block of [
      original.replace("PROVED: [CRITICAL]", "OPEN: [CRITICAL]"),
      original + "RETRACT 1: the lemma has a counterexample\n",
      original + "OPEN: [CRITICAL] An omitted case remains — round1_plan\n",
      original + "OPEN: [GOAL] The wider posed claim remains — round1_plan\n",
      original.replace("PROVED: [CRITICAL]", "SKETCHED: [CRITICAL]"),
    ]) {
      await writeFile(join(root, "round1_ledger_block.md"), block);
      assert((await proofLedger(root, { operation: "gate", directory: ".", round: 1 })).verdict === "REJECT", "Unsettled or retracted load-bearing claim slipped through gate");
    }
  });
});

Deno.test("transitive missing support, circular support and audit self-support fail closed", async () => {
  await withRun(async (root) => {
    await gateFixture(root);
    const original = await readFile(join(root, "round1_ledger_block.md"), "utf8");
    for (const block of [
      original.replace("The support lemma", "The support lemma using entry 9"),
      original.replace("The support lemma", "The support lemma using entry 2"),
      original.replace("using entry 1", "using entry 3"),
      original.replace("using entry 1", "using entry 2"),
    ]) {
      await writeFile(join(root, "round1_ledger_block.md"), block);
      assert((await proofLedger(root, { operation: "gate", directory: ".", round: 1 })).verdict === "REJECT", "Invalid support graph concluded");
    }
  });
});

Deno.test("stale and partial locators and repeated audit sources do not certify a chain", async () => {
  await withRun(async (root) => {
    await gateFixture(root);
    const original = await readFile(join(root, "round1_ledger_block.md"), "utf8");
    for (const block of [
      original.replace("— round1_q1", "— missing_q1"),
      original.replace("— round1_q4", "— round1_q3"),
      original.replace("The proof of entry 2 checks independently", "The proof of entry 99 checks independently"),
    ]) {
      await writeFile(join(root, "round1_ledger_block.md"), block);
      assert((await proofLedger(root, { operation: "gate", directory: ".", round: 1 })).verdict === "REJECT", "Stale locator or audit source qualified");
    }
    await writeFile(join(root, "round1_ledger_block.md"), original);
    await writeFile(join(root, "round1_q4.answer.md"), "The reviewer did not finish.\n");
    const before = await snapshot(root);
    assert((await proofLedger(root, { operation: "gate", directory: ".", round: 1 })).verdict === "REJECT", "Partial answer filename falsely counted as certification");
    assert(await snapshot(root) === before, "Gate classified or moved an incomplete answer");
    await writeFile(join(root, "round1_q4.answer.md"), "\n");
    await proofLedger(root, { operation: "answers", directory: ".", stems: ["round1_q4"] });
    assert((await proofLedger(root, { operation: "gate", directory: ".", round: 1 })).verdict === "REJECT", "No-answer provenance falsely counted as a completed locator");
  });
});

Deno.test("a newer goal requires an audit citing its current ID and an audited disproof may conclude", async () => {
  await withRun(async (root) => {
    await gateFixture(root);
    const original = await readFile(join(root, "round1_ledger_block.md"), "utf8");
    await writeFile(join(root, "round1_ledger_block.md"), original + "PROVED: [GOAL] Restated conclusion using entry 2 — round1_q2\n");
    assert((await proofLedger(root, { operation: "gate", directory: ".", round: 1 })).verdict === "REJECT", "Audits of old goal silently retagged");
    await writeFile(join(root, "round1_ledger_block.md"), original + "PROVED: [GOAL] Restated conclusion using entry 2 — round1_q2\nPROVED: [AUDIT] Current entry 5 checks — round1_q3\n");
    assert((await proofLedger(root, { operation: "gate", directory: ".", round: 1 })).verdict === "CONCLUDE", "Current goal audit plus independent chain audit rejected");
    await writeFile(join(root, "round1_ledger_block.md"), original.replace("PROVED: [GOAL]", "REFUTED: [GOAL]"));
    assert((await proofLedger(root, { operation: "gate", directory: ".", round: 1 })).verdict === "CONCLUDE", "Audited disproof did not settle goal");
  });
});

Deno.test("terminal marker requires exactly the own query and the last meaningful line", () => {
  for (const input of [
    "Proof\n=== END OF ANSWER round2_q3 ===\n",
    "Proof\n> **END OF ANSWER: round2\\_q3.answer.md**\n```\n</details>\n",
    "Proof\n__END OF ANSWER round2_q3__\n",
    "Proof\nEND OF ANSWER /run/round2_q3.md.\n",
  ]) assert(isFinishedAnswer(input, "round2_q3"), "Legitimate decorated terminal marker rejected");
  for (const input of [
    "Proof\n=== END OF ANSWER round2_q4 ===\n",
    "Proof\n=== END OF ANSWER round2_q3_ ===\n",
    "Proof\n- [x] END OF ANSWER round2_q3\n",
    "Proof\nPlease write END OF ANSWER round2_q3\n",
    "Proof\nEND OF ANSWER round2_q3\nA further unresolved step.\n",
    "Proof\nEND OF ANSWER round2_q3\n<details class=\"more\">\n",
  ]) assert(!isFinishedAnswer(input, "round2_q3"), "Wrong, nonterminal or mentioned marker accepted");
  assert(isFinishedAnswer("END OF ANSWER q_", "q_"), "A legal trailing-underscore stem could not finish");
  assert(!citedIds("L2 norm; Claim 2.4; line 1/2; lines L2 and L4").size, "Mathematical notation misread as ledger support");
  assert([...citedIds("entry L5 and #7 and line 9")].sort((a, b) => a - b).join(",") === "5,7,9", "Explicit ledger citations not recognized");
});

Deno.test("unfinished answers retain the longest partial and the other nonempty version", async () => {
  await withRun(async (root) => {
    await writeFile(join(root, "q.md"), "Question");
    const long = "A long checked lead, but not yet a completed answer.";
    await writeFile(join(root, "q.partial.md"), long);
    await writeFile(join(root, "q.answer.md"), "Short lead");
    let outcome = await proofLedger(root, { operation: "answers", directory: ".", stems: ["q", "q.md"] });
    assert(outcome.answers?.length === 1 && outcome.answers[0].status === "partial", "Duplicate classification or incomplete-answer status wrong");
    assert(await readFile(join(root, "q.partial.md"), "utf8") === long, "Longer previous partial lost");
    assert(await readFile(join(root, "q.partial.prev.md"), "utf8") === "Short lead", "New shorter nonempty partial discarded");
    const before = await snapshot(root);
    await proofLedger(root, { operation: "answers", directory: ".", stems: ["q"] });
    assert(await snapshot(root) === before, "Classification was not idempotent");
    const longer = long + " An additional useful derivation.";
    await writeFile(join(root, "q.answer.md"), longer);
    await proofLedger(root, { operation: "answers", directory: ".", stems: ["q"] });
    assert(await readFile(join(root, "q.partial.md"), "utf8") === longer, "Longer new partial not retained");
    assert(await readFile(join(root, "q.partial.prev.md"), "utf8") === long, "Old primary partial discarded instead of archived");
    await writeFile(join(root, "q.answer.md"), "   \n");
    outcome = await proofLedger(root, { operation: "answers", directory: ".", stems: ["q"] });
    assert(outcome.answers?.[0].status === "partial", "Empty answer suppressed existing partial");
    assert(!(await readdir(root)).includes("q.answer.md"), "Empty answer file was not removed");
    assert(await readFile(join(root, "q.noanswer.md"), "utf8") === "", "Empty answer provenance was not retained");
    await answers(root, ["q"]);
    outcome = await proofLedger(root, { operation: "answers", directory: ".", stems: ["q"] });
    assert(outcome.answers?.[0].status === "answered", "Finished answer not recognized");
    assert(await readFile(join(root, "q.partial.md"), "utf8") === longer, "Finished answer erased historical partial");
  });
});

Deno.test("answer totals distinguish completed partial and empty artifacts", async () => {
  await withRun(async (root) => {
    await answers(root, ["finished"]);
    await writeFile(join(root, "partial.answer.md"), "Useful unfinished argument");
    await writeFile(join(root, "empty.answer.md"), "\n");
    await writeFile(join(root, "absent.md"), "A question with no answer");
    const outcome = await proofLedger(root, { operation: "answers", directory: ".", stems: ["finished", "partial", "empty", "absent"] });
    assert(outcome.totals?.answered === 1 && outcome.totals.partial === 1 && outcome.totals.noAnswer === 2, "Classification totals misrepresented unfinished or missing work");
    assert(outcome.answers?.map((row) => row.status).join(",") === "answered,partial,no answer,no answer", "Per-query classification disagreed with totals");
    assert(await readFile(join(root, "partial.partial.md"), "utf8") === "Useful unfinished argument", "Partial mathematical material lost");
    assert(!(await readdir(root)).includes("empty.answer.md"), "Empty artifact retained as an answer");
  });
});

Deno.test("an answer-only empty artifact replays as no answer without a query file", async () => {
  await withRun(async (root) => {
    await writeFile(join(root, "empty.answer.md"), "\n");
    const request = { operation: "answers" as const, directory: ".", stems: ["empty"] };
    const initial = await proofLedger(root, request);
    assert(initial.verdict === "ANSWERS" && initial.answers?.[0].status === "no answer", "Empty answer-only artifact was not classified");
    assert(await readFile(join(root, "empty.noanswer.md"), "utf8") === "", "Empty answer provenance marker was not created");
    assert(!(await readdir(root)).includes("empty.answer.md"), "Empty answer filename survived classification");
    const before = await snapshot(root);
    const replay = await proofLedger(root, request);
    assert(replay.verdict === "ANSWERS" && replay.answers?.[0].status === "no answer" && replay.totals?.noAnswer === 1, "Answer-only empty replay became a missing artifact");
    assert(await snapshot(root) === before, "No-answer replay mutated provenance");
  });
});

Deno.test("mixed batch replay accepts new work and provenance does not suppress partial or finished answers", async () => {
  await withRun(async (root) => {
    await writeFile(join(root, "empty.answer.md"), "\n");
    await writeFile(join(root, "partial.answer.md"), "An unfinished derivation");
    await answers(root, ["finished"]);
    const request = { operation: "answers" as const, directory: ".", stems: ["empty", "partial", "finished"] };
    await proofLedger(root, request);
    await writeFile(join(root, "new.answer.md"), "New useful unfinished work");
    for (const bad of ["never_existed", "../new"]) {
      const before = await snapshot(root);
      const rejected = await proofLedger(root, { ...request, stems: [...request.stems, "new", bad] });
      assert(rejected.verdict === "ERROR", "No-answer provenance admitted a missing or malformed other stem");
      assert(await snapshot(root) === before, "Rejected replay batch mutated new work");
    }
    const replay = await proofLedger(root, { ...request, stems: [...request.stems, "new"] });
    assert(replay.verdict === "ANSWERS" && replay.answers?.map((row) => row.status).join(",") === "no answer,partial,answered,partial", "Formerly empty stem blocked classification of new batch work");
    assert(replay.totals?.answered === 1 && replay.totals.partial === 2 && replay.totals.noAnswer === 1, "Mixed replay totals lost existing or new work");
    assert(await readFile(join(root, "new.partial.md"), "utf8") === "New useful unfinished work", "New batch answer was not preserved");
    await writeFile(join(root, "empty.partial.md"), "A later useful derivation");
    const partial = await proofLedger(root, { ...request, stems: ["empty.noanswer.md"] });
    assert(partial.answers?.[0].status === "partial", "No-answer marker suppressed an existing partial");
    await answers(root, ["empty"]);
    const finished = await proofLedger(root, { ...request, stems: ["empty"] });
    assert(finished.answers?.[0].status === "answered", "No-answer marker suppressed a completed answer");
    assert(await readFile(join(root, "empty.noanswer.md"), "utf8") === "", "Later work overwrote no-answer provenance");
  });
});

Deno.test("answers preflight every stem and symlink before mutating any answer", async () => {
  await withRun(async (root) => {
    await writeFile(join(root, "q.md"), "Question");
    await writeFile(join(root, "q.answer.md"), "An incomplete useful answer");
    await writeFile(join(root, "empty.answer.md"), "\n");
    for (const bad of ["../q", "a/q", "q\\x", "q-name", "q\0", "absent"]) {
      const before = await snapshot(root);
      assert((await proofLedger(root, { operation: "answers", directory: ".", stems: ["q", "empty", bad] })).verdict === "ERROR", "Malformed or never-existing later stem accepted");
      assert(await snapshot(root) === before, "Earlier answer mutated before batch validation");
    }
    await symlink(join(root, "q.answer.md"), join(root, "q.partial.prev.md"));
    const before = await snapshot(root);
    assert((await proofLedger(root, { operation: "answers", directory: ".", stems: ["q"] })).verdict === "ERROR", "Symlink archive accepted");
    assert(await snapshot(root) === before, "Symlink failure mutated answer");
  });
});

Deno.test("no-answer marker destinations reject collisions and unsafe paths before batch mutation", async () => {
  for (const invalid of ["content", "directory", "symlink"]) {
    await withRun(async (root) => {
      await writeFile(join(root, "first.answer.md"), "\n");
      await writeFile(join(root, "blocked.answer.md"), "\n");
      const marker = join(root, "blocked.noanswer.md");
      if (invalid === "content") await writeFile(marker, "Do not clobber this artifact");
      else if (invalid === "directory") await mkdir(marker);
      else await symlink(join(root, "blocked.answer.md"), marker);
      const before = await snapshot(root);
      assert((await proofLedger(root, { operation: "answers", directory: ".", stems: ["first", "blocked"] })).verdict === "ERROR", "Unsafe or nonempty no-answer marker accepted");
      assert(await snapshot(root) === before, "Marker preflight clobbered an artifact or mutated an earlier answer");
    });
  }
  await withRun(async (root) => {
    await writeFile(join(root, "q.noanswer.md"), " \n");
    await writeFile(join(root, "q.answer.md"), "\n\n");
    const outcome = await proofLedger(root, { operation: "answers", directory: ".", stems: ["q"] });
    assert(outcome.answers?.[0].status === "no answer", "Valid existing no-answer marker rejected");
    assert(await readFile(join(root, "q.noanswer.md"), "utf8") === " \n", "Existing no-answer marker was overwritten");
    assert(!(await readdir(root)).includes("q.answer.md"), "New empty answer was retained despite valid provenance");
  });
});

Deno.test("retry attempts persist despite caller resets and terminal TAIL never upgrades to success", async () => {
  await withRun(async (root) => {
    await gateFixture(root);
    const request = { operation: "check" as const, directory: ".", round: 1, wave: 4, minRounds: 0, attempt: 1 };
    for (const [index, verdict] of ["RETRY", "RETRY", "TAIL"].entries()) {
      const outcome = await proofLedger(root, request);
      assert(outcome.verdict === verdict && outcome.attempt === index + 1, "Caller could reset persisted attempts");
    }
    await writeFile(join(root, "round1_summary.md"), "A later summary");
    await writeFile(join(root, "round1_DONE.md"), "A later conclusion");
    const before = await snapshot(root);
    const replay = await proofLedger(root, request);
    assert(replay.verdict === "TAIL" && replay.attempt === 3, "Terminal failure upgraded after exhaustion");
    assert(await snapshot(root) === before, "Terminal replay changed artifacts");
  });
});

Deno.test("failed gate remains fail closed even after minimum round and retry exhaustion", async () => {
  await withRun(async (root) => {
    await writeFile(join(root, "round1_summary.md"), "The goal is still open");
    await writeFile(join(root, "round1_ledger_block.md"), "OPEN: [GOAL] Main goal — round1_plan\n");
    const request = { operation: "check" as const, directory: ".", round: 1, wave: 2, minRounds: 0, attempt: 1 };
    for (const verdict of ["RETRY", "RETRY", "TAIL"]) {
      await writeFile(join(root, "round1_DONE.md"), "Claimed completion without proof");
      assert((await proofLedger(root, request)).verdict === verdict, "Unaudited conclusion accepted at floor or after retries");
    }
    assert(await readFile(join(root, "ledger.md"), "utf8") === "1. OPEN: [GOAL] Main goal — round1_plan\n", "TAIL did not preserve valid partial ledger");
  });
});

Deno.test("valid check concludes only an audited chain and replays its terminal outcome", async () => {
  await withRun(async (root) => {
    await gateFixture(root);
    await writeFile(join(root, "round1_summary.md"), "Full candidate proof and audits available");
    await writeFile(join(root, "round1_DONE.md"), "The full proof was checked");
    const request = { operation: "check" as const, directory: ".", round: 1, wave: 4, minRounds: 4 };
    const outcome = await proofLedger(root, request);
    assert(outcome.verdict === "CONCLUDE" && outcome.appended === 4, "Audited early conclusion rejected");
    const before = await snapshot(root);
    assert((await proofLedger(root, request)).verdict === "CONCLUDE", "Conclusion not persisted");
    assert(await snapshot(root) === before, "Terminal conclusion replay mutated files");
  });
});

Deno.test("wave normalization preserves withdrawn and excess plans and supersedes DONE", async () => {
  await withRun(async (root) => {
    await writeFile(join(root, "round1_summary.md"), "Open goal with concrete questions");
    await writeFile(join(root, "round1_ledger_block.md"), "OPEN: [GOAL] Main goal — round1_plan\n");
    await writeFile(join(root, "round1_q1.md"), "(withdrawn)");
    await writeFile(join(root, "round1_q3.md"), "kind: attempt\nProve the critical lemma.");
    await writeFile(join(root, "round1_q4.md"), "kind: attack\nSeek a counterexample.");
    await writeFile(join(root, "round1_q9.md"), "kind: attempt\nA surplus question.");
    await writeFile(join(root, "round1_DONE.md"), "Premature conclusion");
    const outcome = await proofLedger(root, { operation: "check", directory: ".", round: 1, wave: 2, minRounds: 4 });
    assert(outcome.verdict === "WAVE" && outcome.queries?.join(",") === "round1_q1,round1_q2" && outcome.floor === 1, "Normalized wave/floor wrong");
    assert(await readFile(join(root, "round1_q1.withdrawn.md"), "utf8") === "(withdrawn)", "Withdrawn plan lost");
    assert((await readFile(join(root, "round1_q3.overcount.md"), "utf8")).includes("surplus"), "Overcount query lost");
    assert(await readFile(join(root, "round1_DONE.superseded.md"), "utf8") === "Premature conclusion", "Competing DONE lost");
  });
});

Deno.test("query quota failure exhausts to TAIL rather than accepting an under-quota wave", async () => {
  await withRun(async (root) => {
    await writeFile(join(root, "round1_summary.md"), "Open question");
    await writeFile(join(root, "round1_q1.md"), "Polish exposition, do not attempt an obligation.");
    const request = { operation: "check" as const, directory: ".", round: 1, wave: 1, minRounds: 4 };
    for (const verdict of ["RETRY", "RETRY", "TAIL"]) assert((await proofLedger(root, request)).verdict === verdict, "Under-quota wave falsely accepted");
  });
});

Deno.test("malformed plans, persisted states, renumbered answers and output paths never mutate", async () => {
  await withRun(async (root) => {
    await writeFile(join(root, "round1_summary.md"), "A running summary");
    await writeFile(join(root, "round1_ledger_block.md"), "NOT_A_STATUS: bad claim\n");
    const request = { operation: "check" as const, directory: ".", round: 1, wave: 2, minRounds: 4 };
    let before = await snapshot(root);
    assert((await proofLedger(root, request)).verdict === "ERROR", "Malformed block accepted");
    assert(await snapshot(root) === before, "Malformed block wrote retry state");
    await writeFile(join(root, "round1_ledger_block.md"), "OPEN: [GOAL] Main goal — round1_plan\n");
    for (const malformed of ["../outside", "/outside", "bad\0path"]) {
      before = await snapshot(root);
      assert((await proofLedger(root, { ...request, directory: malformed })).verdict === "ERROR", "Escaping or malformed directory accepted");
      assert(await snapshot(root) === before, "Bad path changed run");
    }
    await symlink(root, join(root, "linked"), "dir");
    before = await snapshot(root);
    assert((await proofLedger(root, { ...request, directory: "linked" })).verdict === "ERROR", "Symlink run accepted");
    assert(await snapshot(root) === before, "Symlink run failure changed files");
    await mkdir(join(root, "judge"));
    await writeFile(join(root, "judge/plan_r1_state.json"), '{"round":1,"attempts":0}');
    before = await snapshot(root);
    assert((await proofLedger(root, request)).verdict === "ERROR", "Malformed persisted count reset");
    assert(await snapshot(root) === before, "Bad state mutated");
    await rm(join(root, "judge/plan_r1_state.json"));
    await writeFile(join(root, "round1_q3.md"), "kind: attempt\nA substantive question.");
    await answers(root, ["round1_q3"]);
    before = await snapshot(root);
    assert((await proofLedger(root, request)).verdict === "ERROR", "Renumbered query divorced from its existing answer");
    assert(await snapshot(root) === before, "Renumbering error mutated plan");
    await rm(join(root, "round1_q3.answer.md"));
    await writeFile(join(root, "round1_q3.noanswer.md"), "");
    before = await snapshot(root);
    assert((await proofLedger(root, request)).verdict === "ERROR", "Renumbered query divorced from its no-answer provenance");
    assert(await snapshot(root) === before, "No-answer renumbering error mutated plan");
    await rm(join(root, "round1_q3.noanswer.md"));
    await symlink(join(root, "round1_summary.md"), join(root, "ledger.md"));
    before = await snapshot(root);
    assert((await proofLedger(root, request)).verdict === "ERROR", "Symlink ledger output accepted");
    assert(await snapshot(root) === before, "Symlink output changed artifacts");
  });
});

Deno.test("malformed numeric settings and noncanonical round names reject without writes", async () => {
  await withRun(async (root) => {
    await writeFile(join(root, "round1_summary.md"), "Open question");
    const request = { operation: "check" as const, directory: ".", round: 1, wave: 2, minRounds: 4 };
    for (const changed of [{ round: 0 }, { round: 1.5 }, { round: NaN }, { wave: 0 }, { minRounds: -1 }, { attempt: 0 }, { attempt: 4 }]) {
      const before = await snapshot(root);
      assert((await proofLedger(root, { ...request, ...changed })).verdict === "ERROR", "Malformed numeric settings accepted");
      assert(await snapshot(root) === before, "Malformed settings mutated a run");
    }
    await writeFile(join(root, "round01_ledger.md"), "1. OPEN: [GOAL] Noncanonical part — round1_plan\n");
    const before = await snapshot(root);
    assert((await proofLedger(root, { operation: "append", directory: ".", round: 1 })).verdict === "ERROR", "Ambiguous round alias accepted");
    assert(await snapshot(root) === before, "Noncanonical part validation changed files");
  });
});
