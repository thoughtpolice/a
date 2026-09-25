// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import {
  type AgentEvent,
  Conversation,
  functionTool,
  GptClient,
  GptError,
  runAgent,
  ToolRegistry,
  tryRunAgent,
} from "@celld/api/openai";
import {
  FakeResponses,
  jsonResponse,
  type ScriptStep,
  virtualRuntime,
} from "@celld/api/openai/testing";
import { v } from "@celld/sieve";

const lookup = functionTool({
  name: "lookup",
  description: "Looks a key up.",
  parameters: v.strictObject({ key: v.string() }),
  risk: "read",
  mutates: false,
  run: ({ key }) => `value-of-${key}`,
});

const remove = functionTool({
  name: "remove",
  description: "Deletes a key.",
  parameters: v.object({ key: v.string() }),
  risk: "write",
  run: ({ key }) => `removed ${key}`,
});

function setup(script: ScriptStep[]) {
  const fake = new FakeResponses(script);
  const runtime = virtualRuntime();
  const client = new GptClient({
    fetch: fake.fetch,
    runtime,
    model: "gpt-5.5",
    retry: { maxRetries: 0 },
  });
  return { fake, client, runtime };
}

Deno.test("the model may call tools in parallel only when none of them mutates", async () => {
  const bodies = [];
  for (const tools of [[lookup], [lookup, remove]]) {
    const { fake, client } = setup([{ text: "done" }]);
    await runAgent({
      client,
      conversation: new Conversation().user("hi"),
      tools: new ToolRegistry(tools),
    });
    bodies.push(fake.requests[0].body.parallel_tool_calls);
  }
  assertEquals(bodies, [true, false]);
  // An explicit request setting wins.
  const { fake, client } = setup([{ text: "done" }]);
  await runAgent({
    client,
    conversation: new Conversation().user("hi"),
    tools: new ToolRegistry([lookup, remove]),
    request: { parallelToolCalls: true },
  });
  assertEquals(fake.requests[0].body.parallel_tool_calls, true);
});

Deno.test("the loop runs tools until the model answers", async () => {
  const { fake, client } = setup([
    {
      toolCalls: [{ name: "lookup", arguments: { key: "a" }, callId: "c1" }, {
        name: "lookup",
        arguments: { key: "b" },
        callId: "c2",
      }],
    },
    { text: "a and b looked up", phase: "final_answer" },
  ]);
  const events: AgentEvent[] = [];
  const conversation = new Conversation().user("look up a and b");
  const result = await runAgent({
    client,
    conversation,
    tools: new ToolRegistry([lookup]),
    onEvent: (event) => events.push(event),
  });
  assertEquals(
    [result.stopReason, result.text, result.turns, result.toolCalls],
    [
      "completed",
      "a and b looked up",
      2,
      2,
    ],
  );
  const second = fake.requests[1].body;
  assertEquals(second.tools.map((tool: { name: string }) => tool.name), [
    "lookup",
  ]);
  assertEquals(second.input.slice(-2), [
    { type: "function_call_output", call_id: "c1", output: "value-of-a" },
    { type: "function_call_output", call_id: "c2", output: "value-of-b" },
  ]);
  assertEquals(result.usage.totalTokens, 240);
  assertEquals(
    events.filter((event) => event.type !== "stream").map((event) =>
      event.type
    ),
    ["turn", "tools", "turn"],
  );
  assert(
    events.some((event) => event.type === "stream"),
    "stream events are forwarded",
  );
  assertEquals(result.conversation.items.length, conversation.items.length);
});

Deno.test("tool errors go back to the model, which can recover", async () => {
  const { fake, client } = setup([
    { toolCalls: [{ name: "lookup", arguments: { wrong: 1 }, callId: "c1" }] },
    { toolCalls: [{ name: "lookup", arguments: { key: "k" }, callId: "c2" }] },
    { text: "done" },
  ]);
  const result = await runAgent({
    client,
    conversation: new Conversation().user("go"),
    tools: new ToolRegistry([lookup]),
  });
  assertEquals(result.stopReason, "completed");
  const outputs = fake.requests[1].body.input.filter((item: { type: string }) =>
    item.type === "function_call_output"
  );
  assertEquals(
    outputs[0].output,
    'error: invalid arguments: key: missing required key; (root): unrecognized key: "wrong"',
  );
});

Deno.test("max turns stops the loop with every call answered", async () => {
  const { client } = setup([
    { toolCalls: [{ name: "lookup", arguments: { key: "a" } }] },
    { toolCalls: [{ name: "lookup", arguments: { key: "b" } }] },
  ]);
  const conversation = new Conversation().user("loop forever");
  const result = await runAgent({
    client,
    conversation,
    tools: new ToolRegistry([lookup]),
    maxTurns: 2,
  });
  assertEquals([result.stopReason, result.turns, result.text], [
    "max_turns",
    2,
    "",
  ]);
  assertEquals(conversation.pendingCalls(), []);
});

Deno.test("a spent token budget stops the loop and answers pending calls as not run", async () => {
  const { fake, client } = setup([
    {
      toolCalls: [{ name: "lookup", arguments: { key: "a" }, callId: "c1" }],
      usage: { input: 900, output: 200 },
    },
  ]);
  let ran = 0;
  const counting = functionTool({
    ...lookup,
    parameters: lookup.parameters,
    run: () => String(++ran),
  });
  const conversation = new Conversation().user("go");
  const result = await runAgent({
    client,
    conversation,
    tools: new ToolRegistry([counting]),
    budget: { tokens: 1000 },
  });
  assertEquals([result.stopReason, ran, fake.requests.length], [
    "token_budget",
    0,
    1,
  ]);
  const last = conversation.items[conversation.items.length - 1];
  assertEquals(last, {
    type: "function_call_output",
    call_id: "c1",
    output: "error: not run: the run's budget is spent",
  });
});

Deno.test("a spent time budget stops before the next turn", async () => {
  const { fake, client, runtime } = setup([{
    toolCalls: [{ name: "lookup", arguments: { key: "a" } }],
  }, { text: "unused" }]);
  const slow = functionTool({
    ...lookup,
    parameters: lookup.parameters,
    run: () => {
      runtime.advance(10_000);
      return "slow";
    },
  });
  const result = await runAgent({
    client,
    conversation: new Conversation().user("go"),
    tools: new ToolRegistry([slow]),
    budget: { timeMs: 5_000 },
    runtime,
  });
  assertEquals([result.stopReason, result.toolCalls, fake.requests.length], [
    "time_budget",
    1,
    1,
  ]);
});

Deno.test("approval gates risky calls; denials reach the model", async () => {
  const { fake, client } = setup([
    {
      toolCalls: [
        { name: "remove", arguments: { key: "prod" }, callId: "c1" },
        { name: "lookup", arguments: { key: "x" }, callId: "c2" },
      ],
    },
    { text: "could not remove prod" },
  ]);
  const result = await runAgent({
    client,
    conversation: new Conversation().user("clean up"),
    tools: new ToolRegistry([lookup, remove]),
    approve: (request) =>
      request.tool.risk === "read" ||
      { allow: false, reason: "no deleting prod" },
  });
  assertEquals(result.stopReason, "completed");
  const outputs = fake.requests[1].body.input.filter((item: { type: string }) =>
    item.type === "function_call_output"
  );
  assertEquals(outputs.map((item: { output: string }) => item.output), [
    "denied: no deleting prod",
    "value-of-x",
  ]);
});

Deno.test("a model failure throws, leaving the conversation resumable", async () => {
  const { client } = setup([
    { toolCalls: [{ name: "lookup", arguments: { key: "a" }, callId: "c1" }] },
    jsonResponse({
      error: { code: "context_length_exceeded", message: "too long" },
    }, { status: 400 }),
  ]);
  const conversation = new Conversation().user("go");
  let error: unknown;
  try {
    await runAgent({ client, conversation, tools: new ToolRegistry([lookup]) });
  } catch (caught) {
    error = caught;
  }
  assert(
    error instanceof GptError && error.kind === "context_window",
    "context window",
  );
  assertEquals([conversation.turns, conversation.pendingCalls().length], [
    1,
    0,
  ]);
});

Deno.test("tryRunAgent returns the failure as data", async () => {
  const { client } = setup([
    jsonResponse({ error: { message: "who" } }, { status: 401 }),
  ]);
  const outcome = await tryRunAgent({
    client,
    conversation: new Conversation().user("go"),
  });
  assert(!outcome.ok, "failed");
  assertEquals(outcome.error.kind, "authentication");
});

Deno.test("a resumed conversation answers its pending calls first", async () => {
  const { fake, client } = setup([{ text: "resumed fine" }]);
  const conversation = new Conversation().user("go").push({
    type: "function_call",
    call_id: "c9",
    name: "lookup",
    arguments: '{"key":"z"}',
  });
  const result = await runAgent({
    client,
    conversation,
    tools: new ToolRegistry([lookup]),
  });
  assertEquals([result.stopReason, result.toolCalls], ["completed", 1]);
  assertEquals(fake.requests[0].body.input[2], {
    type: "function_call_output",
    call_id: "c9",
    output: "value-of-z",
  });
});

Deno.test("steps are named from the conversation's position", async () => {
  const { client } = setup([{
    toolCalls: [{ name: "lookup", arguments: { key: "a" } }],
  }, { text: "ok" }]);
  const names: string[] = [];
  await runAgent({
    client,
    conversation: new Conversation().user("go"),
    tools: new ToolRegistry([lookup]),
    steps: (name, _kind, run) => {
      names.push(name);
      return run();
    },
  });
  assertEquals(names, ["turn-0", "tools-0", "turn-1"]);
});

Deno.test("request settings apply to every turn", async () => {
  const { fake, client } = setup([{ text: "ok" }]);
  await runAgent({
    client,
    conversation: new Conversation({ id: "conv" }).user("go"),
    request: { reasoning: { effort: "high" }, verbosity: "low" },
  });
  assertEquals([
    fake.requests[0].body.reasoning.effort,
    fake.requests[0].body.text.verbosity,
    fake.requests[0].body.prompt_cache_key,
  ], [
    "high",
    "low",
    "conv",
  ]);
  let message = "";
  try {
    await runAgent({ client, conversation: new Conversation(), maxTurns: 0 });
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message, "maxTurns must be a positive integer, got 0");
});

// DB-REV-OAI-4: an abort mid-batch recorded none of the batch, so resuming
// ran the calls that had already finished a second time.
Deno.test("an aborted batch is recorded, and resuming does not rerun it", async () => {
  let runsA = 0;
  const a = functionTool({
    name: "a",
    description: "d",
    parameters: v.strictObject({}),
    run: () => `a ran ${++runsA}`,
  });
  const b = functionTool({
    name: "b",
    description: "d",
    parameters: v.strictObject({}),
    workspace: {},
    run: (_args, context) =>
      new Promise((_, reject) =>
        context.signal.addEventListener(
          "abort",
          () => reject(context.signal.reason),
        )
      ),
  });
  const { fake, client } = setup([
    {
      toolCalls: [
        { name: "a", arguments: {}, callId: "ca" },
        { name: "b", arguments: {}, callId: "cb" },
      ],
    },
    { text: "fine" },
  ]);
  const conversation = new Conversation().user("go");
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("user pressed stop")), 100);
  let error: unknown;
  try {
    await runAgent({
      client,
      conversation,
      tools: new ToolRegistry([a, b]),
      signal: controller.signal,
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof GptError && error.kind === "aborted", String(error));
  assertEquals(runsA, 1);
  assertEquals(conversation.pendingCalls(), []);
  const result = await runAgent({
    client,
    conversation,
    tools: new ToolRegistry([a, b]),
    maxTurns: 1,
  });
  assertEquals([runsA, result.stopReason], [1, "completed"]);
  const outputs = fake.requests[1].body.input.filter((
    item: { type: string },
  ) => item.type === "function_call_output");
  assertEquals(outputs, [
    { type: "function_call_output", call_id: "ca", output: "a ran 1" },
    {
      type: "function_call_output",
      call_id: "cb",
      output: "error: aborted while running; the call stopped",
    },
  ]);
});

Deno.test("a resumed conversation does not rerun a pending mutating call", async () => {
  let removed = 0;
  const counting = functionTool({
    name: "remove",
    description: "Deletes a key.",
    parameters: v.object({ key: v.string() }),
    run: ({ key }) => `removed ${key} ${++removed}`,
  });
  const pending = () =>
    new Conversation().user("go").push({
      type: "function_call",
      call_id: "c1",
      name: "remove",
      arguments: '{"key":"a"}',
    }, {
      type: "function_call",
      call_id: "c2",
      name: "lookup",
      arguments: '{"key":"z"}',
    });
  const { fake, client } = setup([{ text: "ok" }, { text: "ok" }]);
  await runAgent({
    client,
    conversation: pending(),
    tools: new ToolRegistry([counting, lookup]),
  });
  assertEquals(removed, 0);
  assertEquals(fake.requests[0].body.input.slice(3), [
    {
      type: "function_call_output",
      call_id: "c1",
      output:
        "error: not run: interrupted before its result was recorded; it may have run; check before repeating it",
    },
    { type: "function_call_output", call_id: "c2", output: "value-of-z" },
  ]);
  await runAgent({
    client,
    conversation: pending(),
    tools: new ToolRegistry([counting, lookup]),
    unsafeRerunPendingMutations: true,
  });
  assertEquals(removed, 1);
});
