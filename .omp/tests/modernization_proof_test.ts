// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  proofPack,
  snapshot,
} from "../skills/modernization/scripts/proof_pack.ts";
function assert(value: unknown, why: string): asserts value {
  if (!value) throw new Error(why);
}
Deno.test("proof requires all current measured checks, counts distinct fresh inputs and detects a silent canary", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-modernization-proof-"));
  try {
    await mkdir(join(root, "candidate"));
    await mkdir(join(root, "source"));
    await writeFile(
      join(root, "candidate", "main.ts"),
      "// RULE-001\nexport const threshold = 10;\n",
    );
    await utimes(join(root, "candidate", "main.ts"), 10, 10);
    await writeFile(
      join(root, "source", "main.ts"),
      "export const threshold = 10;\n",
    );
    await writeFile(
      join(root, "snapshot.json"),
      JSON.stringify(await snapshot(join(root, "source"))),
    );
    await writeFile(
      join(root, "rules.md"),
      "### RULE-001: inclusive threshold\n**Priority:** P0\n**Confidence:** High\n**Source:** main.ts:1\n",
    );
    await writeFile(
      join(root, "clean.xml"),
      '<testsuite name="ThresholdTest"><testcase name="RULE-001_inclusive"/></testsuite>',
    );
    await utimes(join(root, "clean.xml"), 30, 30);
    await writeFile(
      join(root, "canary.patch"),
      "--- a/candidate/main.ts\n+++ b/candidate/main.ts\n@@ -2 +2 @@\n-export const threshold = 10;\n+export const threshold = 11;\n",
    );
    await utimes(join(root, "canary.patch"), 15, 15);
    await writeFile(
      join(root, "canary.xml"),
      '<testsuite name="ThresholdTest"><testcase name="RULE-001_inclusive"><failure message="Wrong threshold"/></testcase></testsuite>',
    );
    await utimes(join(root, "canary.xml"), 20, 20);
    const development = {
      cases: [{
        id: "development",
        legacy: "dev-old.out",
        candidate: "dev-new.out",
        input: "dev-input",
      }],
    };
    await writeFile(join(root, "dev-input"), "development input");
    for (const path of ["dev-old.out", "dev-new.out"]) {
      await writeFile(join(root, path), "development result\n");
      await utimes(join(root, path), 25, 25);
    }
    await utimes(join(root, "dev-input"), 25, 25);
    await writeFile(
      join(root, "development.json"),
      JSON.stringify(development),
    );
    const fresh = {
      cases: [] as {
        id: string;
        legacy: string;
        candidate: string;
        input: string;
      }[],
    };
    for (let i = 0; i < 10; i++) {
      const c = {
        id: `fresh-${i}`,
        legacy: `fresh-${i}-old.out`,
        candidate: `fresh-${i}-new.out`,
        input: `fresh-${i}.input`,
      };
      fresh.cases.push(c);
      await writeFile(join(root, c.input), `fresh input ${i}`);
      await utimes(join(root, c.input), 25, 25);
      for (const path of [c.legacy, c.candidate]) {
        await writeFile(join(root, path), `fresh result ${i}\n`);
        await utimes(join(root, path), 25, 25);
      }
    }
    await writeFile(join(root, "fresh.json"), JSON.stringify(fresh));
    const request = {
      track: "rewrite",
      code: "candidate",
      sourceRoot: "source",
      sourceSnapshot: "snapshot.json",
      results: ["clean.xml"],
      rules: "rules.md",
      development: "development.json",
      fresh: "fresh.json",
      canaries: [{ patch: "canary.patch", results: ["canary.xml"] }],
    };
    const proven = await proofPack(root, request);
    assert(
      proven.verdict === "PROVEN" &&
        proven.checks.every((c) => c.state === "pass"),
      "Complete current evidence did not establish all checks",
    );
    for (const c of fresh.cases) c.input = "fresh-0.input";
    await writeFile(join(root, "fresh.json"), JSON.stringify(fresh));
    const reused = await proofPack(root, request);
    assert(
      reused.verdict === "PARTLY PROVEN" &&
        reused.checks.find((c) => c.id === "fresh")?.state === "gap",
      "Ten output pairs for one input counted as ten inputs",
    );
    await writeFile(
      join(root, "canary.xml"),
      '<testsuite name="ThresholdTest"><testcase name="RULE-001_inclusive"/></testsuite>',
    );
    await utimes(join(root, "canary.xml"), 20, 20);
    const silent = await proofPack(root, request);
    assert(
      silent.verdict === "NOT PROVEN" &&
        silent.checks.find((c) => c.id === "canary")?.state === "fail",
      "Undetected deliberate break did not fail proof",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
