// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  chunkDiff,
  chunkDisassembly,
  chunkLines,
  chunkLog,
  contextBudgetChars,
  estimateTokens,
  mapChunks,
} from "@celld/api/openai";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  "@@ -10,2 +10,2 @@",
  "-ten",
  "+TEN",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "-b",
  "+B",
].join("\n");

Deno.test("estimates and budgets", () => {
  assertEquals(estimateTokens("abcdefgh"), 2);
  assertEquals(estimateTokens("abc"), 1);
  assertEquals(
    contextBudgetChars("gpt-6-astra"),
    Math.floor((272_000 - 32_000) * 0.5 * 4),
  );
  assertEquals(
    contextBudgetChars("unknown", { reserveTokens: 0, fraction: 1 }),
    512_000,
  );
});

Deno.test("line chunks respect the size and cover every line once", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const chunks = chunkLines(text, { maxChars: 100 });
  assert(chunks.every((chunk) => chunk.text.length <= 100), "sizes");
  assertEquals(chunks.map((chunk) => chunk.text).join("\n"), text);
  assertEquals(chunks[0].startLine, 1);
  assertEquals(chunks[chunks.length - 1].endLine, 50);
  assert(
    chunks.every((chunk, index) =>
      chunk.index === index && chunk.total === chunks.length
    ),
    "indices",
  );
});

Deno.test("overlap repeats lines between chunks", () => {
  const text = ["a", "b", "c", "d", "e", "f"].map((l) => l.repeat(10)).join(
    "\n",
  );
  const chunks = chunkLines(text, { maxChars: 33, overlapLines: 1 });
  assertEquals(chunks.map((chunk) => [chunk.startLine, chunk.endLine]), [
    [1, 3],
    [3, 5],
    [5, 6],
  ]);
});

Deno.test("a line longer than the budget is split", () => {
  const chunks = chunkLines("x".repeat(100), { maxChars: 40 });
  assertEquals(chunks.map((chunk) => chunk.text).join(""), "x".repeat(100));
  assert(chunks.every((chunk) => chunk.text.length <= 40), "sizes");
});

Deno.test("log chunks number their lines", () => {
  const [chunk] = chunkLog("boot\nerror: disk\nok", { maxChars: 1000 });
  assertEquals(chunk.text, "1: boot\n2: error: disk\n3: ok");
});

Deno.test("a small diff stays one chunk, labelled with its files", () => {
  const [only, ...rest] = chunkDiff(DIFF, { maxChars: 10_000 });
  assertEquals([rest.length, only.label, only.text], [
    0,
    "src/a.ts, src/b.ts",
    DIFF,
  ]);
});

Deno.test("a diff splits between files first", () => {
  const chunks = chunkDiff(DIFF, { maxChars: 200 });
  assertEquals(chunks.map((chunk) => chunk.label), ["src/a.ts", "src/b.ts"]);
  assert(chunks[1].text.startsWith("diff --git a/src/b.ts"), chunks[1].text);
});

Deno.test("a big file splits between hunks, each part with the file header", () => {
  const chunks = chunkDiff(DIFF, { maxChars: 125 });
  const first = chunks.filter((chunk) => chunk.label === "src/a.ts");
  assertEquals(first.length, 2);
  for (const chunk of first) {
    assert(
      chunk.text.startsWith(
        "diff --git a/src/a.ts b/src/a.ts\nindex 111..222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@",
      ),
      chunk.text,
    );
  }
  assert(first[1].text.includes("-ten"), first[1].text);
});

Deno.test("plain diffs (no git header) split at ---/+++ pairs", () => {
  const plain =
    "--- a.c\n+++ a.c\n@@ -1 +1 @@\n-x\n+y\n--- b.c\n+++ b.c\n@@ -1 +1 @@\n-p\n+q";
  const chunks = chunkDiff(plain, { maxChars: 40 });
  assertEquals(chunks.map((chunk) => chunk.label), ["a.c", "b.c"]);
});

Deno.test("disassembly splits at function boundaries", () => {
  const asm = [
    "0000000000401136 <main>:",
    "  401136: push rbp",
    "  401137: mov rbp,rsp",
    "0000000000401150 <helper>:",
    "  401150: ret",
    "sub_401200:",
    "  xor eax, eax",
  ].join("\n");
  const whole = chunkDisassembly(asm, { maxChars: 10_000 });
  assertEquals([whole.length, whole[0].label], [1, "main, helper, sub_401200"]);
  const split = chunkDisassembly(asm, { maxChars: 70 });
  assertEquals(split.map((chunk) => chunk.label), [
    "main",
    "helper, sub_401200",
  ]);
});

Deno.test("mapChunks keeps order and bounds concurrency", async () => {
  const chunks = chunkLines("a\nb\nc\nd", { maxChars: 16 });
  let running = 0;
  let peak = 0;
  const results = await mapChunks(chunks, async (chunk) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5 * (4 - chunk.index)));
    running--;
    return chunk.index;
  }, { concurrency: 2 });
  assertEquals(results, chunks.map((chunk) => chunk.index));
  assert(peak <= 2, `peak ${peak}`);
});

Deno.test("sizes below 16 characters are refused", () => {
  let message = "";
  try {
    chunkLines("x", { maxChars: 3 });
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message, "maxChars must be an integer of at least 16, got 3");
});
