// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  type ApprovalRequest,
  approveByRisk,
  customTool,
  functionTool,
  GptError,
  type ToolCall,
  ToolRegistry,
  truncateMiddle,
} from "@celld/api/openai";
import { v } from "@celld/sieve";

const add = functionTool({
  name: "add",
  description: "Adds two numbers.",
  parameters: v.object({ a: v.number(), b: v.number() }),
  risk: "read",
  run: ({ a, b }) => ({ sum: a + b }),
});

const echo = customTool({
  name: "echo",
  description: "Echoes its input.",
  format: { type: "grammar", syntax: "regex", definition: "^[a-z ]+$" },
  risk: "write",
  run: (input) => input.toUpperCase(),
});

function fn(name: string, args: string, callId = `c-${name}`): ToolCall {
  return { kind: "function", callId, name, arguments: args };
}

Deno.test("definitions are what the Responses API expects", () => {
  const registry = new ToolRegistry([add, echo]);
  assertEquals(registry.definitions(), [
    {
      type: "function",
      name: "add",
      description: "Adds two numbers.",
      parameters: add.jsonSchema,
      strict: true,
    },
    {
      type: "custom",
      name: "echo",
      description: "Echoes its input.",
      format: { type: "grammar", syntax: "regex", definition: "^[a-z ]+$" },
    },
  ]);
  assertEquals([registry.size, registry.names], [2, ["add", "echo"]]);
});

Deno.test("calls run with typed arguments and results become output items", async () => {
  const registry = new ToolRegistry([add, echo]);
  const [sum, shout] = await registry.execute([
    fn("add", '{"a":2,"b":3}'),
    { kind: "custom", callId: "c-echo", name: "echo", input: "hi there" },
  ]);
  assertEquals([sum.status, sum.output, sum.item], ["ok", '{"sum":5}', {
    type: "function_call_output",
    call_id: "c-add",
    output: '{"sum":5}',
  }]);
  assertEquals([shout.status, shout.item.type, shout.output], [
    "ok",
    "custom_tool_call_output",
    "HI THERE",
  ]);
});

Deno.test("bad arguments are refused before the handler with paths", async () => {
  let ran = false;
  const tool = functionTool({
    name: "t",
    description: "d",
    parameters: v.strictObject({ n: v.int() }),
    run: () => {
      ran = true;
      return "";
    },
  });
  const [notJson, wrong] = await new ToolRegistry([tool]).execute([
    fn("t", "{oops"),
    fn("t", '{"n":"1","x":2}'),
  ]);
  assertEquals([notJson.status, notJson.output], [
    "invalid_arguments",
    "error: invalid arguments: not JSON",
  ]);
  assertEquals(
    wrong.output,
    'error: invalid arguments: n: expected number, received string; (root): unrecognized key: "x"',
  );
  assert(!ran, "the handler never ran");
});

Deno.test("empty arguments count as an empty object", async () => {
  const tool = functionTool({
    name: "now",
    description: "d",
    parameters: v.object({}),
    run: () => "tick",
  });
  assertEquals(
    (await new ToolRegistry([tool]).execute([fn("now", "")]))[0].output,
    "tick",
  );
});

Deno.test("unknown tools and kind mismatches are answered, not thrown", async () => {
  const registry = new ToolRegistry([add]);
  const [missing, wrongKind] = await registry.execute([
    fn("nope", "{}"),
    { kind: "custom", callId: "x", name: "add", input: "1+1" },
  ]);
  assertEquals(
    missing.output,
    'error: unknown function tool "nope"; available: add',
  );
  assertEquals(wrongKind.status, "unknown_tool");
});

Deno.test("handler errors and timeouts become outputs", async () => {
  const boom = functionTool({
    name: "boom",
    description: "d",
    parameters: v.object({}),
    run: () => {
      throw new Error("kaput");
    },
  });
  let aborted = false;
  const slow = functionTool({
    name: "slow",
    description: "d",
    parameters: v.object({}),
    timeoutMs: 20,
    run: (_args, context) =>
      new Promise((resolve) => {
        context.signal.addEventListener("abort", () => {
          aborted = true;
          resolve("late");
        });
      }),
  });
  const [failed, timed] = await new ToolRegistry([boom, slow]).execute([
    fn("boom", "{}"),
    fn("slow", "{}"),
  ]);
  assertEquals([failed.status, failed.output], ["error", "error: kaput"]);
  assertEquals([timed.status, timed.output], [
    "timeout",
    "error: timed out after 20 ms",
  ]);
  assert(aborted, "the handler's signal fired");
});

Deno.test("the approver sees plain data and can deny with a reason", async () => {
  const seen: ApprovalRequest[] = [];
  const registry = new ToolRegistry([add, echo]);
  const results = await registry.execute([fn("add", '{"a":1,"b":1}'), {
    kind: "custom",
    callId: "e",
    name: "echo",
    input: "rm",
  }], {
    approve: (request) => {
      seen.push(request);
      return request.tool.risk === "read"
        ? true
        : { allow: false, reason: "writes need a human" };
    },
    turn: 3,
  });
  assertEquals(results.map((result) => [result.status, result.output]), [[
    "ok",
    '{"sum":2}',
  ], ["denied", "denied: writes need a human"]]);
  assertEquals(seen[0].args, { a: 1, b: 1 });
  assertEquals([seen[1].args, seen[1].tool.risk, seen[1].turn], [
    "rm",
    "write",
    3,
  ]);
  assertEquals(JSON.parse(JSON.stringify(seen[0])), seen[0]);
});

Deno.test("an approver that throws denies", async () => {
  const [result] = await new ToolRegistry([add]).execute([
    fn("add", '{"a":1,"b":1}'),
  ], {
    approve: () => {
      throw new Error("jev down");
    },
  });
  assertEquals(result.output, "denied: approval failed: jev down");
});

Deno.test("approveByRisk allows listed risks and asks about the rest", async () => {
  const policy = approveByRisk({ allow: ["read"] });
  const request = (risk: "read" | "exec") => ({
    call: fn("x", "{}"),
    tool: { name: "x", kind: "function" as const, description: "", risk },
    args: {},
    turn: 0,
  });
  assertEquals(await policy(request("read")), true);
  assertEquals(await policy(request("exec")), {
    allow: false,
    reason: "exec tools need approval",
  });
  const ask = approveByRisk({ allow: [], otherwise: () => true });
  assertEquals(await ask(request("exec")), true);
});

Deno.test("calls run concurrently up to the limit, results stay in order", async () => {
  let running = 0;
  let peak = 0;
  const wait = functionTool({
    name: "wait",
    description: "d",
    parameters: v.object({ ms: v.int() }),
    run: async ({ ms }) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running--;
      return String(ms);
    },
  });
  const calls = [30, 10, 20, 5, 15].map((ms, index) =>
    fn("wait", JSON.stringify({ ms }), `c${index}`)
  );
  const results = await new ToolRegistry([wait]).execute(calls, {
    concurrency: 2,
  });
  assertEquals(results.map((result) => result.output), [
    "30",
    "10",
    "20",
    "5",
    "15",
  ]);
  assertEquals(peak, 2);
});

Deno.test("long outputs are cut in the middle", async () => {
  const big = functionTool({
    name: "big",
    description: "d",
    parameters: v.object({}),
    run: () => "a".repeat(500) + "b".repeat(500),
  });
  const [result] = await new ToolRegistry([big]).execute([fn("big", "{}")], {
    maxOutputChars: 100,
  });
  assertEquals(result.output.length <= 100, true);
  assert(
    result.output.startsWith("aaa") && result.output.endsWith("bbb"),
    result.output,
  );
  assert(result.output.includes("characters omitted"), result.output);
  assertEquals(truncateMiddle("short", 100), "short");
});

Deno.test("skip answers every call without running it", async () => {
  const [result] = await new ToolRegistry([add]).execute([
    fn("add", '{"a":1,"b":2}'),
  ], { skip: "budget spent" });
  assertEquals([result.status, result.output], [
    "skipped",
    "error: not run: budget spent",
  ]);
});

Deno.test("an aborted execution throws once the calls settle", async () => {
  const controller = new AbortController();
  controller.abort();
  let error: unknown;
  try {
    await new ToolRegistry([add]).execute([fn("add", '{"a":1,"b":2}')], {
      signal: controller.signal,
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof GptError && error.kind === "aborted", "aborted");
});

Deno.test("tool specs are checked where they are written", () => {
  const messages: string[] = [];
  const attempts = [
    () =>
      functionTool({
        name: "bad name",
        description: "d",
        parameters: v.object({}),
        run: () => "",
      }),
    () =>
      functionTool({
        name: "t",
        description: " ",
        parameters: v.object({}),
        run: () => "",
      }),
    () =>
      functionTool({
        name: "t",
        description: "d",
        parameters: v.string(),
        run: () => "",
      }),
    () =>
      functionTool({
        name: "t",
        description: "d",
        parameters: v.object({ a: v.string().optional() }),
        run: () => "",
      }),
    () => new ToolRegistry([add, add]),
  ];
  for (const attempt of attempts) {
    try {
      attempt();
    } catch (error) {
      messages.push((error as Error).message);
    }
  }
  assertEquals(messages, [
    'tool name "bad name" must be 1 to 64 letters, digits, _ or -',
    "tool t needs a description",
    "tool t parameters must be an object schema",
    'tool t is strict but its parameters are not: sieve: openai-strict: key "a" may be absent, but every key must be required (at #/properties/a); use .nullable() instead of .optional() in strict mode; the model sends null; pass strict: false',
    "duplicate tool add",
  ]);
});
