// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The tasks extension, server side: creation, polling, input through
 * `tasks/update`, cancellation, expiry, principal binding, notifications on
 * listen streams, and the task cell's rerun-after-crash semantics.
 */

import { assert, assertEquals } from "@celld/assert";
import {
  type ClientCapabilities,
  elicitForm,
  type JSONRPCNotification,
  McpError,
  McpServer,
  MemoryChangeSource,
  MemoryTaskStore,
  META,
  type Principal,
  TaskCell,
  type TaskCellStorage,
  type TaskRecord,
  type TaskRunner,
  TASKS_EXTENSION,
  ToolError,
} from "@celld/mcp";
import { testPrincipal } from "@celld/mcp/testing";
import { v } from "@celld/sieve";
import { errorOf, request, resultOf, SECRET, SERVER_INFO } from "./fixture.ts";

const TASKS: ClientCapabilities = { extensions: { [TASKS_EXTENSION]: {} } };
const WITH_FORMS: ClientCapabilities = {
  ...TASKS,
  elicitation: { form: {} },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A server with a memory task store and a few task tools. */
function taskServer(
  options: {
    now?: () => number;
    changes?: MemoryChangeSource;
    ttlMs?: number | null;
  } = {},
) {
  const store = new MemoryTaskStore({ now: options.now });
  const server = new McpServer({
    info: SERVER_INFO,
    stateSecret: SECRET,
    now: options.now,
    changes: options.changes,
    tasks: { store, ttlMs: options.ttlMs, pollIntervalMs: 20 },
  });
  const released = { value: false };
  server.tool({
    name: "sum",
    description: "Adds, eventually.",
    input: v.strictObject({ a: v.int(), b: v.int() }),
    output: v.strictObject({ sum: v.int() }),
    task: {
      run: async ({ a, b }, ctx) => {
        await ctx.status("adding");
        await sleep(10);
        return { structuredContent: { sum: a + b } };
      },
    },
  });
  server.tool({
    name: "greet",
    description: "Asks for a name while running, then greets it.",
    task: {
      run: (_args, ctx) => {
        const answer = ctx.elicit(
          "name",
          elicitForm("Your name?", {
            type: "object",
            properties: { name: { type: "string", minLength: 2 } },
            required: ["name"],
          }).params,
        );
        if (answer.action !== "accept") return "no name";
        const again = ctx.elicit("confirm", {
          mode: "form",
          message: `Greet ${answer.content?.name}?`,
          requestedSchema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
          },
        });
        return again.content?.ok
          ? `hello ${answer.content?.name}`
          : "not greeting";
      },
    },
  });
  server.tool({
    name: "wait",
    description: "Works until released or cancelled.",
    task: {
      pollIntervalMs: 10,
      run: async (_args, ctx) => {
        while (!released.value) {
          if (ctx.signal.aborted) throw new Error("stopped");
          await sleep(5);
        }
        return "released";
      },
    },
  });
  server.tool({
    name: "confirm-then-task",
    description: "Confirms synchronously (MRTR), then continues as a task.",
    run: (_args, ctx) => {
      const answer = ctx.elicit("go", {
        mode: "form",
        message: "Start?",
        requestedSchema: {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
        },
      });
      if (answer.action !== "accept") return "not started";
      return ctx.task({
        state: { label: answer.content!.label as string },
        statusMessage: "queued",
      });
    },
    task: {
      run: (_args, ctx) => `started ${(ctx.state as { label: string }).label}`,
    },
  });
  server.tool({
    name: "chunks",
    description: "Counts to three, one run at a time.",
    task: {
      run: async (_args, ctx) => {
        const count = ((ctx.state as number | null) ?? 0) + 1;
        await ctx.save(count);
        if (count < 3) ctx.inputRequired();
        return `counted ${count} in ${ctx.run} runs`;
      },
    },
  });
  server.tool({
    name: "maybe",
    description: "A task only when asked for one.",
    input: v.strictObject({ async: v.boolean() }),
    run: ({ async }, ctx) => async ? ctx.task() : "right away",
    task: { run: () => "later" },
  });
  return { server, store, released };
}

async function call(
  server: McpServer,
  method: string,
  params: Record<string, unknown> = {},
  capabilities: ClientCapabilities = TASKS,
  principal: Principal | null = null,
) {
  return await server.handle(request(method, params, { capabilities }), {
    principal,
  });
}

async function poll(
  server: McpServer,
  taskId: string,
  until: (task: Record<string, unknown>) => boolean,
  principal: Principal | null = null,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const task = resultOf(
      await call(server, "tasks/get", { taskId }, TASKS, principal),
    );
    if (until(task)) return task;
    await sleep(5);
  }
  throw new Error(`task ${taskId} never got there`);
}

Deno.test("server/discover advertises the extension", async () => {
  const { server } = taskServer();
  const result = resultOf(await call(server, "server/discover"));
  assertEquals(
    (result.capabilities as Record<string, unknown>).extensions,
    { [TASKS_EXTENSION]: {} },
  );
});

Deno.test("a task tool answers with a task and completes", async () => {
  const { server } = taskServer();
  const created = resultOf(
    await call(server, "tools/call", {
      name: "sum",
      arguments: { a: 2, b: 3 },
    }),
  );
  assertEquals(created.resultType, "task");
  assertEquals(created.status, "working");
  assertEquals(created.ttlMs, 3_600_000);
  assertEquals(created.pollIntervalMs, 20);
  const taskId = created.taskId as string;
  assert(/^[A-Za-z0-9_-]{24}$/.test(taskId), `task id ${taskId}`);
  assert(!Number.isNaN(Date.parse(created.createdAt as string)), "createdAt");
  assertEquals(
    (created._meta as Record<string, unknown>)[META.serverInfo],
    SERVER_INFO,
  );
  const done = await poll(
    server,
    taskId,
    (task) => task.status === "completed",
  );
  assertEquals(done.resultType, "complete");
  assertEquals(done.result, {
    resultType: "complete",
    content: [{ type: "text", text: '{"sum":5}' }],
    structuredContent: { sum: 5 },
  });
  assertEquals(done.statusMessage, undefined);
});

Deno.test("a task-only tool needs the extension (-32021)", async () => {
  const { server } = taskServer();
  const error = errorOf(
    await call(
      server,
      "tools/call",
      { name: "sum", arguments: { a: 1, b: 1 } },
      {},
    ),
  );
  assertEquals(error.code, -32021);
  assertEquals(error.data, {
    requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
  });
});

Deno.test("the handler decides per call whether to make a task", async () => {
  const { server } = taskServer();
  const now = resultOf(
    await call(server, "tools/call", {
      name: "maybe",
      arguments: { async: false },
    }),
  );
  assertEquals(now.content, [{ type: "text", text: "right away" }]);
  const later = resultOf(
    await call(server, "tools/call", {
      name: "maybe",
      arguments: { async: true },
    }),
  );
  assertEquals(later.resultType, "task");
  // Without the extension, the synchronous path still works.
  const plain = resultOf(
    await call(
      server,
      "tools/call",
      { name: "maybe", arguments: { async: false } },
      {},
    ),
  );
  assertEquals(plain.content, [{ type: "text", text: "right away" }]);
});

Deno.test("tasks methods need the extension and a known task", async () => {
  const { server } = taskServer();
  assertEquals(
    errorOf(await call(server, "tasks/get", { taskId: "nope" }, {})).code,
    -32021,
  );
  assertEquals(
    errorOf(await call(server, "tasks/get", { taskId: "nope" })),
    { code: -32602, message: "Failed to retrieve task: Task not found" },
  );
  assertEquals(
    errorOf(
      await call(server, "tasks/update", {
        taskId: "nope",
        inputResponses: {},
      }),
    ).code,
    -32602,
  );
  assertEquals(
    errorOf(await call(server, "tasks/cancel", { taskId: "nope" })).code,
    -32602,
  );
  assertEquals(
    errorOf(await call(server, "tasks/get", {})).code,
    -32602,
  );
  // A server without tasks does not know the methods.
  const plain = new McpServer({ info: SERVER_INFO });
  assertEquals(
    errorOf(await call(plain, "tasks/get", { taskId: "x" })).code,
    -32601,
  );
});

Deno.test("a task belongs to the principal that created it", async () => {
  const { server } = taskServer();
  const alice = testPrincipal("alice");
  const bob = testPrincipal("bob");
  const created = resultOf(
    await call(
      server,
      "tools/call",
      { name: "greet" },
      WITH_FORMS,
      alice,
    ),
  );
  const taskId = created.taskId as string;
  await poll(server, taskId, (task) => task.status === "input_required", alice);
  for (const who of [bob, null]) {
    assertEquals(
      errorOf(await call(server, "tasks/get", { taskId }, TASKS, who)).message,
      "Failed to retrieve task: Task not found",
    );
    assertEquals(
      errorOf(
        await call(
          server,
          "tasks/update",
          {
            taskId,
            inputResponses: {
              name: { action: "accept", content: { name: "mallory" } },
            },
          },
          TASKS,
          who,
        ),
      ).code,
      -32602,
    );
    assertEquals(
      errorOf(await call(server, "tasks/cancel", { taskId }, TASKS, who)).code,
      -32602,
    );
  }
  const still = resultOf(
    await call(server, "tasks/get", { taskId }, TASKS, alice),
  );
  assertEquals(still.status, "input_required");
});

Deno.test("input requests go out on tasks/get and come back on tasks/update", async () => {
  const { server } = taskServer();
  const taskId = resultOf(
    await call(server, "tools/call", { name: "greet" }, WITH_FORMS),
  ).taskId as string;
  const waiting = await poll(
    server,
    taskId,
    (task) => task.status === "input_required",
  );
  const requests = waiting.inputRequests as Record<string, unknown>;
  assertEquals(Object.keys(requests), ["name"]);
  // The same outstanding request on every poll until it is answered.
  const again = resultOf(await call(server, "tasks/get", { taskId }));
  assertEquals(again.inputRequests, requests);

  // Malformed and schema-violating answers are refused; nothing changes.
  assertEquals(
    errorOf(
      await call(server, "tasks/update", {
        taskId,
        inputResponses: { name: { action: "maybe" } },
      }),
    ).code,
    -32602,
  );
  const short = errorOf(
    await call(server, "tasks/update", {
      taskId,
      inputResponses: { name: { action: "accept", content: { name: "x" } } },
    }),
  );
  assertEquals(short.code, -32602);
  assert(short.message.includes("requested schema"), short.message);

  // Unknown keys are ignored; the answer is acknowledged with an empty result.
  const ack = resultOf(
    await call(server, "tasks/update", {
      taskId,
      inputResponses: {
        other: { action: "accept" },
        name: { action: "accept", content: { name: "ada" } },
      },
    }),
  );
  assertEquals(ack.resultType, "complete");
  assertEquals(Object.keys(ack).sort(), ["_meta", "resultType"]);

  const second = await poll(
    server,
    taskId,
    (task) =>
      task.status === "input_required" &&
      Object.hasOwn(task.inputRequests as object, "confirm"),
  );
  // Answered keys are never asked again.
  assertEquals(Object.keys(second.inputRequests as object), ["confirm"]);
  // A late answer to the first key is ignored.
  resultOf(
    await call(server, "tasks/update", {
      taskId,
      inputResponses: { name: { action: "accept", content: { name: "eve" } } },
    }),
  );
  resultOf(
    await call(server, "tasks/update", {
      taskId,
      inputResponses: { confirm: { action: "accept", content: { ok: true } } },
    }),
  );
  const done = await poll(
    server,
    taskId,
    (task) => task.status === "completed",
  );
  assertEquals((done.result as Record<string, unknown>).content, [{
    type: "text",
    text: "hello ada",
  }]);
});

Deno.test("an input request needs the creating request's capabilities", async () => {
  const { server } = taskServer();
  const taskId = resultOf(
    await call(server, "tools/call", { name: "greet" }, TASKS),
  ).taskId as string;
  const failed = await poll(server, taskId, (task) => task.status === "failed");
  assertEquals((failed.error as { code: number }).code, -32021);
});

Deno.test("cancelling stops the body and is terminal", async () => {
  const { server, store } = taskServer();
  const taskId = resultOf(
    await call(server, "tools/call", { name: "wait" }),
  ).taskId as string;
  await sleep(20);
  assert(store.busy, "the body should be running");
  assertEquals(
    resultOf(await call(server, "tasks/cancel", { taskId })).resultType,
    "complete",
  );
  const cancelled = resultOf(await call(server, "tasks/get", { taskId }));
  assertEquals(cancelled.status, "cancelled");
  assertEquals(cancelled.statusMessage, "The client cancelled the task");
  await sleep(30);
  assert(!store.busy, "the body should have stopped");
  // Cancelling a terminal task is acknowledged and changes nothing.
  resultOf(await call(server, "tasks/cancel", { taskId }));
  assertEquals(
    resultOf(await call(server, "tasks/get", { taskId })).status,
    "cancelled",
  );
});

Deno.test("a finished task ignores cancellation", async () => {
  const { server, released } = taskServer();
  released.value = true;
  const taskId = resultOf(
    await call(server, "tools/call", { name: "wait" }),
  ).taskId as string;
  await poll(server, taskId, (task) => task.status === "completed");
  resultOf(await call(server, "tasks/cancel", { taskId }));
  assertEquals(
    resultOf(await call(server, "tasks/get", { taskId })).status,
    "completed",
  );
});

Deno.test("JSON-RPC errors fail a task; other failures complete it with isError", async () => {
  const errors: unknown[] = [];
  const store = new MemoryTaskStore();
  const server = new McpServer({
    info: SERVER_INFO,
    tasks: { store },
    onError: (error) => errors.push(error),
  });
  server.tool({
    name: "fail",
    input: v.strictObject({ how: v.enum(["rpc", "tool", "crash", "output"]) }),
    output: v.strictObject({ n: v.int() }),
    task: {
      run: ({ how }) => {
        if (how === "rpc") throw McpError.invalidParams("bad input, later");
        if (how === "tool") throw new ToolError("the tool said no");
        if (how === "crash") throw new Error("secret detail");
        return { structuredContent: { n: "not a number" } };
      },
    },
  });
  const outcome = async (how: string) => {
    const taskId = resultOf(
      await call(server, "tools/call", { name: "fail", arguments: { how } }),
    ).taskId as string;
    return await poll(
      server,
      taskId,
      (task) => task.status === "completed" || task.status === "failed",
    );
  };
  const rpc = await outcome("rpc");
  assertEquals(rpc.status, "failed");
  assertEquals(rpc.error, { code: -32602, message: "bad input, later" });
  assertEquals(rpc.statusMessage, "bad input, later");
  const tool = await outcome("tool");
  assertEquals(tool.status, "completed");
  assertEquals(tool.result, {
    content: [{ type: "text", text: "the tool said no" }],
    isError: true,
  });
  const crash = await outcome("crash");
  assertEquals((crash.result as Record<string, unknown>).content, [{
    type: "text",
    text: "Tool fail failed",
  }]);
  assert(!JSON.stringify(crash).includes("secret"), "no internal details");
  const output = await outcome("output");
  assertEquals(output.status, "failed");
  assertEquals(output.error, { code: -32603, message: "Internal error" });
  assertEquals(errors.length, 2);
});

Deno.test("multi round-trip input first, then a task with the state", async () => {
  const { server } = taskServer();
  const first = resultOf(
    await call(server, "tools/call", { name: "confirm-then-task" }, WITH_FORMS),
  );
  assertEquals(first.resultType, "input_required");
  const created = resultOf(
    await call(server, "tools/call", {
      name: "confirm-then-task",
      inputResponses: { go: { action: "accept", content: { label: "v2" } } },
      requestState: first.requestState,
    }, WITH_FORMS),
  );
  assertEquals(created.resultType, "task");
  assertEquals(created.statusMessage, "queued");
  const done = await poll(
    server,
    created.taskId as string,
    (task) => task.status === "completed",
  );
  assertEquals((done.result as Record<string, unknown>).content, [{
    type: "text",
    text: "started v2",
  }]);
});

Deno.test("a body can yield and continue from saved state", async () => {
  const { server } = taskServer();
  const taskId = resultOf(
    await call(server, "tools/call", { name: "chunks" }),
  ).taskId as string;
  const done = await poll(
    server,
    taskId,
    (task) => task.status === "completed",
  );
  assertEquals((done.result as Record<string, unknown>).content, [{
    type: "text",
    text: "counted 3 in 3 runs",
  }]);
});

Deno.test("tasks expire after their TTL", async () => {
  let clock = 1_000_000;
  const { server, store } = taskServer({ now: () => clock, ttlMs: 60_000 });
  const created = resultOf(
    await call(server, "tools/call", {
      name: "sum",
      arguments: { a: 1, b: 2 },
    }),
  );
  assertEquals(created.ttlMs, 60_000);
  assertEquals(created.createdAt, new Date(1_000_000).toISOString());
  const taskId = created.taskId as string;
  await poll(server, taskId, (task) => task.status === "completed");
  clock += 60_000;
  assertEquals(
    errorOf(await call(server, "tasks/get", { taskId })).message,
    "Failed to retrieve task: Task has expired",
  );
  assertEquals(
    errorOf(await call(server, "tasks/get", { taskId })).message,
    "Failed to retrieve task: Task not found",
  );
  assertEquals(store.size, 0);
});

Deno.test("listen streams carry notifications/tasks for the caller's tasks", async () => {
  const changes = new MemoryChangeSource();
  const { server, released } = taskServer({ changes });
  const alice = testPrincipal("alice");
  const mine = resultOf(
    await call(server, "tools/call", { name: "wait" }, TASKS, alice),
  ).taskId as string;
  const theirs = resultOf(
    await call(
      server,
      "tools/call",
      { name: "wait" },
      TASKS,
      testPrincipal("bob"),
    ),
  ).taskId as string;
  const seen: JSONRPCNotification[] = [];
  const controller = new AbortController();
  const listening = server.handle(
    request("subscriptions/listen", {
      notifications: { taskIds: [mine, theirs, "unknown"] },
    }, { capabilities: TASKS, id: "tasks-listen" }),
    {
      principal: alice,
      signal: controller.signal,
      emit: (notification) => {
        seen.push(notification);
      },
    },
  );
  await sleep(20);
  released.value = true;
  for (let i = 0; i < 100 && seen.length < 3; i++) await sleep(5);
  const statuses = seen.slice(1).map((n) =>
    (n.params as Record<string, unknown>).status
  );
  controller.abort();
  await listening;
  assertEquals(seen[0].method, "notifications/subscriptions/acknowledged");
  assertEquals(seen[0].params?.notifications, { taskIds: [mine] });
  assert(
    seen.slice(1).every((n) =>
      n.method === "notifications/tasks" &&
      (n.params as Record<string, unknown>).taskId === mine &&
      (n.params?._meta as Record<string, unknown>)[META.subscriptionId] ===
        "tasks-listen"
    ),
    JSON.stringify(seen),
  );
  assertEquals(statuses[0], "working");
  assertEquals(statuses[statuses.length - 1], "completed");
  const last = seen[seen.length - 1].params as Record<string, unknown>;
  assertEquals((last.result as Record<string, unknown>).content, [{
    type: "text",
    text: "released",
  }]);
});

Deno.test("task notifications need the extension (-32021)", async () => {
  const { server } = taskServer({ changes: new MemoryChangeSource() });
  const error = errorOf(
    await call(server, "subscriptions/listen", {
      notifications: { taskIds: ["x"] },
    }, {}),
  );
  assertEquals(error.code, -32021);
});

Deno.test("registration refuses task tools without a store", () => {
  const server = new McpServer({ info: SERVER_INFO });
  let message = "";
  try {
    server.tool({ name: "t", task: { run: () => "x" } });
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(
    message,
    "tool t runs as a task, but the server has no tasks option",
  );
});

/** A cell's storage whose alarms fire only when the test says. */
function manualStorage() {
  const slot: {
    record: TaskRecord | null;
    alarm: number | null;
    reason: string | null;
  } = { record: null, alarm: null, reason: null };
  const storage: TaskCellStorage = {
    load: () => slot.record === null ? null : structuredClone(slot.record),
    save: (record) => {
      slot.record = structuredClone(record);
    },
    remove: () => {
      slot.record = null;
      slot.alarm = null;
      return Promise.resolve();
    },
    schedule: (at, reason) => {
      slot.alarm = at;
      slot.reason = at === null ? null : reason;
      return Promise.resolve();
    },
    sync: () => Promise.resolve(),
  };
  return { slot, storage };
}

function record(taskId: string, now: number): TaskRecord {
  return {
    version: 1,
    taskId,
    owner: "alice",
    principal: testPrincipal("alice"),
    method: "tools/call",
    name: "job",
    arguments: {},
    protocolVersion: "2026-07-28",
    clientCapabilities: TASKS,
    clientInfo: null,
    status: "working",
    statusMessage: null,
    createdAt: now,
    lastUpdatedAt: now,
    ttlMs: 10_000,
    pollIntervalMs: 100,
    outstanding: {},
    asked: {},
    answers: {},
    state: null,
    result: null,
    error: null,
    runAt: now,
    runs: 0,
  };
}

Deno.test("a cell reruns its body after the host dies mid-run", async () => {
  const clock = 5_000;
  const { slot, storage } = manualStorage();
  let hang = true;
  const runs: { state: unknown; runs: number }[] = [];
  const runner: TaskRunner = {
    async run(task, hooks) {
      runs.push({ state: task.state, runs: task.runs });
      await hooks.save({ step: "half" });
      if (hang) await new Promise(() => {}); // The host dies here.
      return {
        type: "completed",
        result: { content: [], resumedFrom: task.state },
      };
    },
  };
  const first = new TaskCell(storage, () => runner, () => clock);
  assertEquals((await first.create(record("t1", clock))).ok, true);
  assertEquals([slot.alarm, slot.reason], [clock, "run"]);
  void first.alarm(); // Never settles.
  await sleep(1);
  assertEquals(slot.record?.state, { step: "half" });
  // A new instance over the same storage gets the redelivered alarm.
  hang = false;
  const second = new TaskCell(storage, () => runner, () => clock);
  await second.alarm();
  assertEquals(runs, [{ state: null, runs: 1 }, {
    state: { step: "half" },
    runs: 2,
  }]);
  const done = await second.get("alice");
  assert(done.ok, "get");
  assertEquals(done.value.status, "completed");
  assertEquals(done.value.result, {
    content: [],
    resumedFrom: { step: "half" },
  });
  // Next wake-up: expiry.
  assertEquals([slot.alarm, slot.reason], [clock + 10_000, "expire"]);
});

Deno.test("a cell's expiry alarm deletes the task", async () => {
  let clock = 0;
  const { slot, storage } = manualStorage();
  const changed: string[] = [];
  const runner: TaskRunner = {
    run: () => Promise.resolve({ type: "completed", result: { content: [] } }),
    changed: (taskId) => {
      changed.push(taskId);
    },
  };
  const cell = new TaskCell(storage, () => runner, () => clock);
  await cell.create(record("t2", clock));
  await cell.alarm();
  assertEquals(slot.record?.status, "completed");
  clock = 10_000;
  await cell.alarm();
  assertEquals(slot.record, null);
  assertEquals(changed, ["t2", "t2"]);
  const gone = await cell.get("alice");
  assertEquals(gone.ok, false);
});
