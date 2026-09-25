// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A live smoke test against a real ChatGPT-backed exe.dev LLM integration.
 * It only works on an exe.dev VM with the integration attached, so no test
 * target runs it. `buck2 run :live-smoke-run -- <vm> [args]` bundles it,
 * copies it to the VM and runs it there with Deno (`tests/live_smoke.py`).
 * It spends subscription quota: every check is one or two small turns per
 * model.
 *
 * Arguments: `--integration <name>` (default `llm`), `--models a,b,c`
 * (default the GPT-6 family), and `--jev <integration>` to also drive the
 * Jev bridge through an exe.dev HTTP proxy integration for TypeSafe.
 *
 * @module
 */

import { JevClient } from "@celld/api/jev";
import {
  Conversation,
  functionTool,
  GptClient,
  type GptErrorData,
  modelInfo,
  runAgent,
  ToolRegistry,
} from "@celld/api/openai";
import { atLeast, securityReview } from "@celld/api/openai/blueteam";
import { codingTools, MemoryFileSystem } from "@celld/api/openai/coding";
import { routeEffort, scoreOutput } from "@celld/api/openai/jev";
import { v } from "@celld/sieve";

interface Check {
  readonly model: string;
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: unknown;
}

function flag(name: string, fallback: string): string {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < Deno.args.length ? Deno.args[i + 1] : fallback;
}

const integration = flag("integration", "llm");
const models = flag("models", "gpt-6-astra,gpt-6-sol,gpt-6-luna").split(",");
const jevIntegration = flag("jev", "");

const checks: Check[] = [];

async function check(
  model: string,
  name: string,
  body: () => Promise<unknown>,
): Promise<void> {
  const start = Date.now();
  try {
    const detail = await body();
    checks.push({ model, name, ok: true, ms: Date.now() - start, detail });
  } catch (error) {
    const detail = error instanceof Error && "toJSON" in error
      ? (error as { toJSON(): GptErrorData }).toJSON()
      : String(error);
    checks.push({ model, name, ok: false, ms: Date.now() - start, detail });
  }
  const last = checks[checks.length - 1];
  console.error(
    `${last.ok ? "ok  " : "FAIL"} ${model} ${name} (${last.ms} ms)` +
      (last.ok ? "" : ` ${JSON.stringify(last.detail)}`),
  );
}

function expect(condition: boolean, what: string): void {
  if (!condition) throw new Error(`expected ${what}`);
}

const VULNERABLE = `
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
  char name[16];
  strcpy(name, argv[1]);
  printf(name);
  return 0;
}
`;

const probe = new GptClient({ integration });
const listed = new Set((await probe.models.list()).map((card) => card.id));
console.error(`integration ${probe.baseUrl} lists ${listed.size} models`);

for (const model of models) {
  const gpt = new GptClient({ integration, model });

  // Models Codex hides from its picker (the Daybreak ones) are served but
  // missing from `/models`.
  const info = modelInfo(model);
  await check(model, "listed", () => {
    if (info?.listed === false) return Promise.resolve("hidden, not required");
    expect(listed.has(model), `${model} in /models`);
    return Promise.resolve(true);
  });

  await check(model, "respond", async () => {
    const turn = await gpt.respond({
      input: "Reply with exactly the word: pong",
      reasoning: { effort: "low" },
    });
    expect(/pong/i.test(turn.finalText), `pong, got ${turn.finalText}`);
    if (info?.specialty === "cyber") {
      expect(
        turn.accessPrograms?.cyber !== undefined,
        `a cyber access program, got ${JSON.stringify(turn.accessPrograms)}`,
      );
    }
    return {
      accessPrograms: turn.accessPrograms,
      text: turn.finalText,
      servedBy: turn.model,
      usage: turn.usage,
      encoding: turn.meta.encoding,
      rateLimits: turn.meta.rateLimits,
      requestId: turn.meta.requestId,
    };
  });

  await check(model, "stream", async () => {
    const stream = gpt.stream({
      input: "Count from 1 to 5, one number per line.",
      reasoning: { effort: "low" },
    });
    const kinds = new Map<string, number>();
    let text = "";
    for await (const event of stream) {
      kinds.set(event.type, (kinds.get(event.type) ?? 0) + 1);
      if (event.type === "text.delta") text += event.delta;
    }
    const turn = await stream.result;
    expect(text === turn.finalText, "deltas to add up to the final text");
    expect(/1[\s\S]*5/.test(text), `1..5, got ${text}`);
    return { events: Object.fromEntries(kinds) };
  });

  await check(model, "structured", async () => {
    const Answer = v.object({
      capital: v.string(),
      population_millions: v.number().min(0),
      continent: v.enum(["africa", "asia", "europe", "americas", "oceania"]),
    });
    const { value } = await gpt.structured({
      input: "Facts about France.",
      schema: Answer,
      name: "country",
      reasoning: { effort: "low" },
    });
    expect(
      value.capital.toLowerCase() === "paris",
      `paris, got ${value.capital}`,
    );
    expect(value.continent === "europe", "europe");
    return value;
  });

  await check(model, "conversation", async () => {
    const thread = new Conversation({ instructions: "Be terse." });
    thread.user(
      "Pick a secret prime number between 50 and 60; tell me only that you picked one.",
    );
    thread.record(
      await gpt.respond(thread.request({ reasoning: { effort: "medium" } })),
    );
    thread.user("Now tell me the number, digits only.");
    const turn = await gpt.respond(
      thread.request({ reasoning: { effort: "low" } }),
    );
    thread.record(turn);
    // Round-trip through JSON as a Durable Object would store it.
    const resumed = Conversation.fromJSON(
      JSON.parse(JSON.stringify(thread.toJSON())),
    );
    expect(/5[39]/.test(turn.finalText), `53 or 59, got ${turn.finalText}`);
    return {
      answer: turn.finalText,
      items: resumed.items.length,
      cached: turn.usage.cachedInputTokens,
    };
  });

  await check(model, "prompt-cache", async () => {
    // Caching starts at about 1,024 prompt tokens, so pad the instructions
    // well past that; each later turn replays the earlier ones as its
    // prefix. A hit is best-effort (a turn can land on a cold replica), so
    // any of three follow-ups hitting the cache passes.
    const facts = Array.from(
      { length: 300 },
      (_, i) => `Fact ${i}: locker ${i} holds parcel ${1000 + i}.`,
    ).join("\n");
    const thread = new Conversation({ instructions: facts });
    thread.user("Acknowledge the facts in one word.");
    thread.record(
      await gpt.respond(thread.request({ reasoning: { effort: "low" } })),
    );
    const cached: number[] = [];
    for (const locker of [7, 42, 199]) {
      thread.user(`Which parcel is in locker ${locker}? Digits only.`);
      const turn = await gpt.respond(
        thread.request({ reasoning: { effort: "low" } }),
      );
      thread.record(turn);
      const parcel = String(1000 + locker);
      expect(
        turn.finalText.includes(parcel),
        `${parcel}, got ${turn.finalText}`,
      );
      cached.push(turn.usage.cachedInputTokens);
      if (turn.usage.cachedInputTokens > 0) break;
    }
    expect(cached.some((n) => n > 0), `a cache hit, cached tokens ${cached}`);
    return { cachedPerTurn: cached };
  });

  await check(model, "agent+tools", async () => {
    const calls: number[][] = [];
    const add = functionTool({
      name: "add",
      description: "Add a list of integers exactly.",
      parameters: v.object({ values: v.array(v.int()) }),
      risk: "read",
      run: ({ values }) => {
        calls.push(values);
        return Promise.resolve(String(values.reduce((a, b) => a + b, 0)));
      },
    });
    const result = await runAgent({
      client: gpt,
      conversation: new Conversation().user(
        "Use the add tool to compute 123456789 + 987654321 + 555, then reply with only the sum.",
      ),
      tools: new ToolRegistry([add]),
      maxTurns: 6,
      request: { reasoning: { effort: "low" } },
    });
    expect(calls.length > 0, "a tool call");
    expect(
      result.text.replace(/[,\s]/g, "").includes("1111111665"),
      `1111111665, got ${result.text}`,
    );
    return { stop: result.stopReason, turns: result.turns, calls };
  });

  await check(model, "no-arg tool", async () => {
    // An object with no properties: strict mode sends `required: []`.
    let called = 0;
    const secret = functionTool({
      name: "get_secret_word",
      description: "Returns today's secret word. Takes no arguments.",
      parameters: v.object({}),
      risk: "read",
      run: () => {
        called++;
        return Promise.resolve("marmalade");
      },
    });
    const result = await runAgent({
      client: gpt,
      conversation: new Conversation().user(
        "Call get_secret_word, then reply with only the word it returns.",
      ),
      tools: new ToolRegistry([secret]),
      maxTurns: 4,
      request: { reasoning: { effort: "low" } },
    });
    expect(called > 0, "a tool call");
    expect(/marmalade/i.test(result.text), `marmalade, got ${result.text}`);
    return {
      stop: result.stopReason,
      turns: result.turns,
      schema: secret.jsonSchema,
    };
  });

  await check(model, "apply_patch", async () => {
    const fs = new MemoryFileSystem({
      "src/greet.py": "def greet(name):\n    return 'hello ' + name\n",
    });
    const result = await runAgent({
      client: gpt,
      conversation: new Conversation().user(
        "In src/greet.py, change greet so it returns 'Hello, <name>!' (capital H, comma, exclamation mark). " +
          "Use apply_patch. Do not create other files.",
      ),
      tools: new ToolRegistry(codingTools({ fs })),
      maxTurns: 8,
      request: { reasoning: { effort: "low" } },
    });
    const after = fs.snapshot()["src/greet.py"];
    expect(after.includes("Hello, "), `patched file, got ${after}`);
    return { stop: result.stopReason, turns: result.turns, after };
  });

  await check(model, "security-review", async () => {
    const review = await securityReview(gpt, {
      files: { "main.c": VULNERABLE },
      context: "setuid-root helper",
    }, { effort: "low" });
    const serious = atLeast(review.findings, "medium");
    expect(serious.length >= 1, "at least one medium+ finding");
    return serious.map((f) => ({
      severity: f.severity,
      cwe: f.cwe,
      title: f.title,
      line: f.location.startLine,
      confidence: f.confidence,
    }));
  });

  if (jevIntegration !== "") {
    const jev = new JevClient({
      // The integration injects the real key at the edge.
      apiKey: "exe-integration",
      baseUrl: `https://${jevIntegration}.int.exe.xyz`,
    });
    await check(model, "jev-bridge", async () => {
      const route = await routeEffort(
        jev,
        "Rename a local variable in one function.",
      );
      const turn = await gpt.respond({
        input: "In one sentence: why is strcpy into a fixed buffer dangerous?",
        reasoning: { effort: route.effort },
      });
      const graded = await scoreOutput(jev, {
        task: "Explain why strcpy into a fixed-size buffer is dangerous.",
        output: turn.finalText,
      });
      return { route, score: graded };
    });
  }
}

const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ integration, models, checks }, null, 2));
console.error(
  `${checks.length - failed.length}/${checks.length} checks passed`,
);
Deno.exit(failed.length === 0 ? 0 : 1);
