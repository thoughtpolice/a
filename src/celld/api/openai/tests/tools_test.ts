// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import {
  type ApprovalRequest,
  approveByRisk,
  customTool,
  functionTool,
  GptError,
  type Tool,
  ToolBatchAbortedError,
  type ToolCall,
  type ToolExecution,
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
  // The handler finished (with "late") once its signal fired: the result
  // is reported with the timeout (DB-REV-OAI-6), not dropped.
  assertEquals([timed.status, timed.output], [
    "timeout",
    "error: timed out after 20 ms, but the call finished:\nlate",
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
    mutates: false,
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

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A tool that takes `stopMs` to wind down after its signal fires. */
function stoppable(stopMs: number, log: string[]) {
  return functionTool({
    name: "work",
    description: "d",
    parameters: v.object({}),
    timeoutMs: 20,
    run: (_args, context) =>
      new Promise((_, reject) => {
        context.signal.addEventListener("abort", async () => {
          log.push("abort");
          await delay(stopMs);
          log.push("stopped");
          reject(context.signal.reason);
        });
      }),
  });
}

Deno.test("a timeout is reported only after the handler has stopped", async () => {
  const log: string[] = [];
  const [result] = await new ToolRegistry([stoppable(60, log)]).execute([
    fn("work", "{}"),
  ]);
  log.push("reported");
  assertEquals(log, ["abort", "stopped", "reported"]);
  assertEquals([result.status, result.output, result.abandoned], [
    "timeout",
    "error: timed out after 20 ms",
    undefined,
  ]);
  assert(result.durationMs >= 60, `took ${result.durationMs} ms`);
});

Deno.test("a handler that ignores its signal is abandoned after the grace period", async () => {
  let finish = () => {};
  const stubborn = functionTool({
    name: "stubborn",
    description: "d",
    parameters: v.object({}),
    timeoutMs: 20,
    run: () => new Promise<string>((resolve) => (finish = () => resolve("x"))),
  });
  const abandoned: ToolExecution[] = [];
  const started = Date.now();
  const [result] = await new ToolRegistry([stubborn]).execute(
    [fn("stubborn", "{}")],
    {
      cancelGraceMs: 50,
      onAbandoned: (execution) => abandoned.push(execution),
    },
  );
  const took = Date.now() - started;
  assert(took >= 70, `reported after ${took} ms, before the grace ran out`);
  assertEquals([result.status, result.abandoned], ["timeout", true]);
  assertEquals(
    result.output,
    "error: timed out after 20 ms; the call did not stop within 50 ms of being cancelled and may still be running",
  );
  assertEquals(abandoned, [result]);
  finish();
});

Deno.test("the reason a handler stopped with reaches the model", async () => {
  const partial = functionTool({
    name: "partial",
    description: "d",
    parameters: v.object({}),
    timeoutMs: 20,
    run: (_args, context) =>
      new Promise((_, reject) => {
        context.signal.addEventListener("abort", () =>
          reject(new Error("2 of 3 files changed")));
      }),
  });
  const [result] = await new ToolRegistry([partial]).execute([
    fn("partial", "{}"),
  ]);
  assertEquals(
    [result.status, result.output],
    ["timeout", "error: timed out after 20 ms\n2 of 3 files changed"],
  );
});

Deno.test("an execution aborted mid-call returns once the call has stopped", async () => {
  const log: string[] = [];
  const tool = stoppable(60, log);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("caller")), 5);
  let error: unknown;
  try {
    await new ToolRegistry([tool]).execute([fn("work", "{}")], {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
  } catch (caught) {
    error = caught;
  }
  log.push("returned");
  assert(error instanceof GptError && error.kind === "aborted", String(error));
  assertEquals(log, ["abort", "stopped", "returned"]);
});

Deno.test("cancelGraceMs is checked", async () => {
  let message = "";
  try {
    await new ToolRegistry([add]).execute([], { cancelGraceMs: -1 });
  } catch (error) {
    message = (error as Error).message;
  }
  assert(message.includes("cancelGraceMs"), message);
});

/** How many calls run at once, for one tool or a group of them. */
interface Gauge {
  running: number;
  peak: number;
}

const gauge = (): Gauge => ({ running: 0, peak: 0 });

/** A 20 ms tool that records itself in `gauges` and `order`. */
function counted(
  name: string,
  spec: { mutates?: boolean; workspace?: object },
  gauges: readonly Gauge[] = [],
  order: string[] = [],
) {
  return functionTool({
    name,
    description: "d",
    parameters: v.object({ id: v.string() }),
    ...spec,
    run: async ({ id }) => {
      for (const g of gauges) g.peak = Math.max(g.peak, ++g.running);
      order.push(`${name}:${id}`);
      await delay(20);
      for (const g of gauges) g.running--;
      return id;
    },
  });
}

Deno.test("tools mutate unless they say otherwise", () => {
  const plain = counted("plain", {});
  const reader = counted("reader", { mutates: false });
  assertEquals([plain.mutates, reader.mutates], [true, false]);
  assertEquals(new ToolRegistry([reader]).readOnly, true);
  assertEquals(new ToolRegistry([reader, plain]).readOnly, false);
  assertEquals(new ToolRegistry().readOnly, true);
});

Deno.test("two mutating calls on one workspace never overlap; read-only calls do", async () => {
  const workspace = {};
  const writes = gauge();
  const reads = gauge();
  const order: string[] = [];
  const registry = new ToolRegistry([
    counted("write", { workspace }, [writes], order),
    counted("patch", { workspace }, [writes], order),
    counted("read", { mutates: false, workspace }, [reads], order),
  ]);
  const calls = ["write", "read", "patch", "read", "write", "read"].map(
    (name, index) =>
      fn(name, JSON.stringify({ id: String(index) }), `c${index}`),
  );
  const results = await registry.execute(calls, { concurrency: 4 });
  assertEquals(results.map((result) => result.output), [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
  ]);
  assertEquals(writes.peak, 1);
  assert(reads.peak >= 2, `reads ran ${reads.peak} at a time`);
  assertEquals(
    order.filter((entry) => !entry.startsWith("read")),
    ["write:0", "patch:2", "write:4"],
  );
});

Deno.test("mutations are serialized per workspace, across executions too", async () => {
  const shared = {};
  const together = gauge();
  const one = new ToolRegistry([
    counted("a", { workspace: shared }, [together]),
  ]);
  const two = new ToolRegistry([
    counted("b", { workspace: shared }, [together]),
  ]);
  await Promise.all([
    one.execute([fn("a", '{"id":"1"}')]),
    two.execute([fn("b", '{"id":"2"}')]),
    one.execute([fn("a", '{"id":"3"}')]),
  ]);
  assertEquals(together.peak, 1);
  const apart = gauge();
  const separate = new ToolRegistry([
    counted("c", { workspace: {} }, [apart]),
    counted("d", { workspace: {} }, [apart]),
  ]);
  await separate.execute([fn("c", '{"id":"1"}'), fn("d", '{"id":"2"}')]);
  assertEquals(apart.peak, 2);
  // Tools that name no workspace share the registry's.
  const unnamed = gauge();
  await new ToolRegistry([
    counted("e", {}, [unnamed]),
    counted("f", {}, [unnamed]),
  ]).execute([fn("e", '{"id":"1"}'), fn("f", '{"id":"2"}')]);
  assertEquals(unnamed.peak, 1);
});

Deno.test("a workspace refuses mutations while an abandoned call may still run", async () => {
  const workspace = {};
  let finish = () => {};
  const stubborn = functionTool({
    name: "stubborn",
    description: "d",
    parameters: v.object({}),
    workspace,
    timeoutMs: 10,
    run: () => new Promise<string>((resolve) => (finish = () => resolve("x"))),
  });
  const registry = new ToolRegistry([
    stubborn,
    counted("write", { workspace }),
    counted("read", { mutates: false, workspace }),
  ]);
  const [abandoned, refused, read] = await registry.execute([
    fn("stubborn", "{}"),
    fn("write", '{"id":"1"}'),
    fn("read", '{"id":"2"}'),
  ], { cancelGraceMs: 20, onAbandoned: () => {} });
  assertEquals([abandoned.status, abandoned.abandoned], ["timeout", true]);
  assertEquals([refused.status, refused.output], [
    "skipped",
    "error: not run: an earlier call on this workspace was abandoned and may still be running",
  ]);
  assertEquals([read.status, read.output], ["ok", "2"]);
  finish();
  await delay(0);
  const [after] = await registry.execute([fn("write", '{"id":"3"}')]);
  assertEquals([after.status, after.output], ["ok", "3"]);
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

// DB-REV-OAI-7: a tool object without `mutates` (built by hand, or before
// the field existed) ran unserialized while every other check counted it
// as mutating.
Deno.test("a tool without mutates is serialized like any mutating tool", async () => {
  const g = gauge();
  const { mutates: _dropped, ...rest } = counted("legacy", {}, [g]);
  const legacy = rest as unknown as Tool;
  const registry = new ToolRegistry([legacy]);
  assertEquals(registry.readOnly, false);
  await registry.execute(
    ["1", "2", "3"].map((id) => fn("legacy", JSON.stringify({ id }), id)),
  );
  assertEquals(g.peak, 1);
  let message = "";
  try {
    new ToolRegistry([{ ...rest, mutates: "no" } as unknown as Tool]);
  } catch (error) {
    message = (error as Error).message;
  }
  assert(message.includes("mutates"), message);
});

// DB-REV-OAI-6: a call that finished after its timeout fired was reported
// only as timed out, inviting the model to redo it.
Deno.test("a timed-out call that finished anyway reports its result", async () => {
  let applied = 0;
  const stubborn = functionTool({
    name: "patch",
    description: "d",
    parameters: v.strictObject({}),
    timeoutMs: 20,
    run: async () => {
      await delay(60);
      applied++;
      return "Success. Updated a.txt";
    },
  });
  const [result] = await new ToolRegistry([stubborn]).execute([
    fn("patch", "{}"),
  ]);
  assertEquals(applied, 1);
  assertEquals([result.status, result.output, result.abandoned], [
    "timeout",
    "error: timed out after 20 ms, but the call finished:\nSuccess. Updated a.txt",
    undefined,
  ]);
});

Deno.test("a call aborted by the caller keeps the handler's own error", async () => {
  const partial = functionTool({
    name: "partial",
    description: "d",
    parameters: v.strictObject({}),
    run: (_args, context) =>
      new Promise((_, reject) => {
        context.signal.addEventListener("abort", () =>
          reject(new Error("2 of 3 files changed")));
      }),
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("caller")), 5);
  let error: unknown;
  try {
    await new ToolRegistry([partial]).execute([fn("partial", "{}")], {
      signal: controller.signal,
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof ToolBatchAbortedError, String(error));
  const [result] = error.executions;
  assertEquals([result.status, result.output], [
    "error",
    "error: aborted\n2 of 3 files changed",
  ]);
});

// DB-REV-OAI-4: the abort error carries every call's execution, so the
// ones that finished are recorded rather than left pending.
Deno.test("an aborted batch carries the executions of every call", async () => {
  let runs = 0;
  const quick = functionTool({
    name: "quick",
    description: "d",
    parameters: v.strictObject({}),
    run: () => `done ${++runs}`,
  });
  const waits = functionTool({
    name: "waits",
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
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("stop")), 20);
  let error: unknown;
  try {
    await new ToolRegistry([quick, waits]).execute([
      fn("quick", "{}", "a"),
      fn("waits", "{}", "b"),
      fn("quick", "{}", "c"),
    ], { signal: controller.signal, concurrency: 2 });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof ToolBatchAbortedError, String(error));
  assert(error instanceof GptError && error.kind === "aborted", "aborted");
  assertEquals(
    error.executions.map((e) => [e.callId, e.status, e.output]),
    [
      ["a", "ok", "done 1"],
      ["b", "error", "error: aborted while running; the call stopped"],
      ["c", "ok", "done 2"],
    ],
  );
});

Deno.test("skipMutating answers mutating calls and runs read-only ones", async () => {
  let writes = 0;
  const write = functionTool({
    name: "write",
    description: "d",
    parameters: v.strictObject({}),
    run: () => String(++writes),
  });
  const sum = functionTool({
    name: "sum",
    description: "d",
    parameters: v.object({ a: v.number(), b: v.number() }),
    mutates: false,
    run: ({ a, b }) => ({ sum: a + b }),
  });
  const results = await new ToolRegistry([write, sum]).execute([
    fn("write", "{}"),
    fn("sum", '{"a":1,"b":2}'),
  ], { skipMutating: "interrupted" });
  assertEquals(writes, 0);
  assertEquals(results.map((r) => [r.status, r.output]), [
    ["skipped", "error: not run: interrupted"],
    ["ok", '{"sum":3}'],
  ]);
});

// DB-REV-OAI-10 and DB-SWP-F7-303: timer and size knobs were unchecked; a
// bad timeout threw mid-batch while sibling workers kept starting calls.
Deno.test("timeouts and output limits are checked where they are given", async () => {
  const make = (timeoutMs: number) => () =>
    functionTool({
      name: "t",
      description: "d",
      parameters: v.strictObject({}),
      timeoutMs,
      run: () => "x",
    });
  for (const bad of [2 ** 31, NaN, Infinity, -1]) {
    let message = "";
    try {
      make(bad)();
    } catch (error) {
      message = (error as Error).message;
    }
    assert(message.includes("timeoutMs"), `${bad}: ${message}`);
  }
  const registry = new ToolRegistry([add]);
  const cases: [string, Record<string, number>][] = [
    ["timeoutMs", { timeoutMs: Infinity }],
    ["timeoutMs", { timeoutMs: 2 ** 31 }],
    ["maxOutputChars", { maxOutputChars: NaN }],
    ["maxOutputChars", { maxOutputChars: -5 }],
    ["maxOutputChars", { maxOutputChars: Infinity }],
    ["concurrency", { concurrency: 1.5 }],
  ];
  for (const [name, options] of cases) {
    let message = "";
    let ran = false;
    try {
      await registry.execute([fn("add", '{"a":1,"b":2}')], options);
      ran = true;
    } catch (error) {
      message = (error as Error).message;
    }
    assert(!ran && message.includes(name), `${name}: ${message}`);
  }
  // A hand-built tool object is checked when it is registered.
  const { timeoutMs: _t, ...plain } = make(10)();
  let message = "";
  try {
    new ToolRegistry([{ ...plain, timeoutMs: NaN } as unknown as Tool]);
  } catch (error) {
    message = (error as Error).message;
  }
  assert(message.includes("timeoutMs"), message);
});

Deno.test("a batch stops handing out calls once one fails", async () => {
  let started = 0;
  const slow = functionTool({
    name: "s",
    description: "d",
    parameters: v.strictObject({ id: v.string() }),
    workspace: {},
    mutates: false,
    run: async () => {
      started++;
      await delay(30);
      return "ok";
    },
  });
  const registry = new ToolRegistry([slow]);
  let error: unknown;
  // A runtime whose first timer throws stands in for any failure inside
  // the registry: execute must not keep starting calls after it.
  let running = 0;
  let later = 0;
  const runtime = {
    now: () => Date.now(),
    random: () => 0.5,
    sleep: (ms: number) => delay(ms),
    setTimer: (ms: number, fire: () => void) => {
      if (++running === 1) throw new RangeError("timer refused");
      const id = setTimeout(fire, ms);
      return () => clearTimeout(id);
    },
  };
  started = 0;
  try {
    await registry.execute(
      ["1", "2", "3", "4"].map((id) => fn("s", JSON.stringify({ id }), id)),
      { concurrency: 2, runtime },
    );
  } catch (caught) {
    error = caught;
    later = started;
  }
  assert(error instanceof RangeError, String(error));
  await delay(100);
  assertEquals(started, later, "no call started after execute rejected");
  assert(started <= 1, `started ${started}`);
});

Deno.test("a slow approval keeps its call's place in the workspace", async () => {
  const first = Promise.withResolvers<boolean>();
  const order: string[] = [];
  const registry = new ToolRegistry([customTool({
    name: "write",
    description: "Append a line to a shared file",
    mutates: true,
    run: (input) => {
      order.push(input);
      return "ok";
    },
  })]);
  const calls: ToolCall[] = ["first", "second"].map((input) => ({
    kind: "custom",
    name: "write",
    callId: input,
    input,
  }));
  const task = registry.execute(calls, {
    approve: ({ call }) => call.callId === "first" ? first.promise : true,
  });
  await delay(20);
  assertEquals(order, [], "the second call waits for the first's approval");
  first.resolve(true);
  const results = await task;
  assertEquals(order, ["first", "second"]);
  assertEquals(results.map((result) => result.status), ["ok", "ok"]);
  // A denial gives the place up.
  const denied = Promise.withResolvers<boolean>();
  order.length = 0;
  const refused = registry.execute(calls, {
    approve: ({ call }) => call.callId === "first" ? denied.promise : true,
  });
  await delay(20);
  assertEquals(order, []);
  denied.resolve(false);
  assertEquals((await refused).map((result) => result.status), [
    "denied",
    "ok",
  ]);
  assertEquals(order, ["second"]);
});

Deno.test("a pending approval holds only its own workspace's mutations", async () => {
  const workspace = {};
  const held = Promise.withResolvers<boolean>();
  const order: string[] = [];
  const registry = new ToolRegistry([
    counted("write", { workspace }, [], order),
    counted("elsewhere", { workspace: {} }, [], order),
    counted("read", { mutates: false, workspace }, [], order),
  ]);
  const calls = [
    fn("write", '{"id":"1"}', "held"),
    fn("write", '{"id":"2"}'),
    fn("read", '{"id":"3"}'),
    fn("elsewhere", '{"id":"4"}'),
  ];
  const task = registry.execute(calls, {
    approve: ({ call }) => call.callId === "held" ? held.promise : true,
  });
  await delay(60);
  assertEquals(order.sort(), ["elsewhere:4", "read:3"]);
  held.resolve(true);
  await task;
  assertEquals(order.slice(2), ["write:1", "write:2"]);
});

Deno.test("a call cancelled during its approval gives its place up", async () => {
  const controller = new AbortController();
  const order: string[] = [];
  const registry = new ToolRegistry([counted("write", {}, [], order)]);
  const task = registry.execute([
    fn("write", '{"id":"1"}', "a"),
    fn("write", '{"id":"2"}', "b"),
  ], {
    approve: ({ call }) =>
      call.callId === "a"
        ? new Promise<boolean>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(true))
        )
        : true,
    signal: controller.signal,
  });
  await delay(20);
  controller.abort(new Error("stop"));
  let error: unknown;
  try {
    await task;
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof ToolBatchAbortedError, String(error));
  assertEquals(order, []);
  // The workspace is free again.
  const [after] = await registry.execute([fn("write", '{"id":"3"}')]);
  assertEquals([after.status, order], ["ok", ["write:3"]]);
});
