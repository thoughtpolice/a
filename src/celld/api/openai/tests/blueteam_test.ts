// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  GptClient,
  GptError,
  requestIssues,
  strictSchema,
} from "@celld/api/openai";
import {
  atLeast,
  dedupeFindings,
  type Finding,
  ReNotes,
  reverseEngineer,
  SecurityReview,
  securityReview,
  sortFindings,
  Triage,
  triage,
} from "@celld/api/openai/blueteam";
import {
  FakeResponses,
  type RecordedRequest,
  virtualRuntime,
} from "@celld/api/openai/testing";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    title: "SQL injection in search",
    severity: "high",
    cwe: "CWE-89",
    location: {
      path: "src/search.ts",
      startLine: 12,
      endLine: 14,
      symbol: "search",
    },
    evidence: "query built with string concatenation",
    exploitability: "any user can reach /search",
    confidence: 0.9,
    remediation: "use a parameterised query",
    ...overrides,
  };
}

function client(fake: FakeResponses) {
  return new GptClient({
    fetch: fake.fetch,
    runtime: virtualRuntime(),
    model: "gpt-5.5",
  });
}

Deno.test("the schemas are valid for strict structured outputs", () => {
  for (const schema of [SecurityReview, ReNotes, Triage]) {
    assertEquals(
      requestIssues({
        input: "x",
        format: { name: "f", schema: strictSchema(schema), strict: true },
      }),
      [],
    );
  }
  assert(
    SecurityReview.safeParse({ summary: "ok", findings: [finding()] }).success,
    "a finding checks",
  );
  const bad = SecurityReview.safeParse({
    summary: "x",
    findings: [finding({ cwe: "89", confidence: 2 })],
  });
  assert(!bad.success, "bad");
  assertEquals(bad.error.issues.map((issue) => issue.path.join(".")), [
    "findings.0.cwe",
    "findings.0.confidence",
  ]);
  const extra = SecurityReview.safeParse({
    summary: "x",
    findings: [],
    note: 1,
  });
  assert(!extra.success, "an extra key is an error");
});

Deno.test("findings sort by severity then confidence, and dedupe", () => {
  const low = finding({
    severity: "low",
    title: "verbose errors",
    location: { path: "a", startLine: 1, endLine: null, symbol: null },
  });
  const unsure = finding({ confidence: 0.4 });
  const sure = finding({ confidence: 0.95 });
  const critical = finding({
    severity: "critical",
    title: "RCE",
    cwe: "CWE-94",
  });
  assertEquals(
    sortFindings([low, unsure, critical, sure]).map((
      f,
    ) => [f.severity, f.confidence]),
    [
      ["critical", 0.9],
      ["high", 0.95],
      ["high", 0.4],
      ["low", 0.9],
    ],
  );
  const deduped = dedupeFindings([unsure, sure, low]);
  assertEquals(deduped.map((f) => f.confidence), [0.95, 0.9]);
  assertEquals(atLeast([low, critical, sure], "high").map((f) => f.severity), [
    "critical",
    "high",
  ]);
});

Deno.test("securityReview sends each chunk with the schema and merges findings", async () => {
  const seen: RecordedRequest[] = [];
  const answer = (findings: Finding[]) => (request: RecordedRequest) => {
    seen.push(request);
    return {
      text: JSON.stringify({ summary: `part ${seen.length}`, findings }),
    };
  };
  const fake = new FakeResponses([
    answer([finding()]),
    answer([
      finding({ confidence: 0.5 }),
      finding({ title: "XSS", cwe: "CWE-79" }),
    ]),
  ]);
  const review = await securityReview(client(fake), {
    files: { "src/search.ts": "line\n".repeat(30), "src/view.ts": "x" },
    context: "an internal search service",
  }, { maxChars: 1000, concurrency: 1 });
  assertEquals(review.chunks, 2);
  assertEquals(review.findings.map((f) => f.title), [
    "SQL injection in search",
    "XSS",
  ]);
  assertEquals(review.result.summary, "part 1\n\npart 2");
  assertEquals(review.usage.totalTokens, 240);
  const body = seen[0].body;
  assertEquals([body.text.format.name, body.reasoning.effort], [
    "security_review",
    "high",
  ]);
  assert(
    body.instructions.includes("defensive code review"),
    body.instructions,
  );
  const input = body.input[0].content[0].text as string;
  assert(
    input.startsWith(
      "Context: an internal search service\nThis is part 1 of 2 of the code (src/search.ts)",
    ),
    input,
  );
  assert(input.includes("// file: src/search.ts\n1: line"), input);
});

Deno.test("securityReview reviews diffs, and needs something to review", async () => {
  const fake = new FakeResponses([{
    text: JSON.stringify({ summary: "clean", findings: [] }),
  }]);
  const review = await securityReview(client(fake), {
    diff: "--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y",
  }, { instructions: "custom", effort: "xhigh" });
  assertEquals(review.findings, []);
  assertEquals([
    fake.requests[0].body.instructions,
    fake.requests[0].body.reasoning.effort,
  ], ["custom", "xhigh"]);
  assert(
    (fake.requests[0].body.input[0].content[0].text as string).includes(
      "<diff>",
    ),
    "framed as a diff",
  );
  let message = "";
  try {
    await securityReview(client(fake), {});
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message, "securityReview needs files or a diff");
});

Deno.test("a policy refusal surfaces as a policy error", async () => {
  const fake = new FakeResponses([
    new Response(
      JSON.stringify({ error: { code: "cyber_policy", message: "flagged" } }),
      { status: 400 },
    ),
  ]);
  let error: unknown;
  try {
    await securityReview(client(fake), { files: { a: "x" } });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof GptError, "gpt error");
  assertEquals([(error as GptError).kind, (error as GptError).code], [
    "policy",
    "cyber_policy",
  ]);
});

Deno.test("reverseEngineer merges notes across functions", async () => {
  const notes = (name: string, capability: string) => ({
    text: JSON.stringify({
      summary: `${name} does things`,
      architecture: name === "main" ? null : "x86-64 SysV",
      functions: [{ name, purpose: "p", confidence: 0.8 }],
      capabilities: [capability, "network"],
      indicators: [{ kind: "domain", value: "evil.example", context: "C2" }],
      vulnerabilities: [],
      openQuestions: [],
    }),
  });
  const fake = new FakeResponses([
    notes("main", "persistence"),
    notes("helper", "crypto"),
  ]);
  const asm = `0000000000401136 <main>:\n${
    "  nop\n".repeat(20)
  }0000000000401150 <helper>:\n${"  nop\n".repeat(20)}`;
  const { result, chunks } = await reverseEngineer(client(fake), {
    disassembly: asm,
  }, { maxChars: 150, concurrency: 1 });
  assertEquals(chunks, 2);
  assertEquals(result.architecture, "x86-64 SysV");
  assertEquals(result.functions.map((f) => f.name), ["main", "helper"]);
  assertEquals(result.capabilities, ["persistence", "network", "crypto"]);
  assertEquals(result.indicators.length, 1);
});

Deno.test("triage decides on one item, cutting a huge one in the middle", async () => {
  const decision = {
    verdict: "true_positive",
    severity: "critical",
    priority: "P0",
    confidence: 0.92,
    rationale: "known-bad hash on a domain controller",
    escalate: true,
    nextSteps: ["isolate host"],
  };
  const fake = new FakeResponses([{ text: JSON.stringify(decision) }, {
    text: JSON.stringify(decision),
  }]);
  const gpt = client(fake);
  const { triage: verdict } = await triage(gpt, {
    alert: "EDR: mimikatz.exe on DC01",
    context: "DC01 is tier 0",
  });
  assertEquals([verdict.priority, verdict.escalate], ["P0", true]);
  assertEquals(fake.requests[0].body.reasoning.effort, "medium");
  await triage(gpt, { alert: "A".repeat(500) + "Z".repeat(500) }, {
    maxChars: 100,
  });
  const text = fake.requests[1].body.input[0].content[0].text as string;
  assert(
    text.includes("A".repeat(50)) && text.includes("Z".repeat(50)) &&
      text.includes("characters omitted"),
    text,
  );
  assert(text.length < 300, `${text.length}`);
});
