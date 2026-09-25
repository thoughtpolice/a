// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import {
  Conversation,
  functionTool,
  GptClient,
  GptError,
  ToolRegistry,
} from "@celld/api/openai";
import { v } from "@celld/sieve";
import {
  FakeResponses,
  fakeStep,
  jsonResponse,
  virtualRuntime,
} from "@celld/api/openai/testing";
import {
  DEFAULT_TOOLS_STEP,
  DEFAULT_TURN_STEP,
  respondStep,
  runAgentWorkflow,
  waitForUsageReset,
} from "@celld/api/openai/workflow";

function client(fake: FakeResponses) {
  return new GptClient({
    fetch: fake.fetch,
    runtime: virtualRuntime(),
    model: "gpt-5.5",
    retry: { maxRetries: 0 },
  });
}

Deno.test("a finished respond step is replayed, not paid for again", async () => {
  const step = fakeStep();
  const fake = new FakeResponses([{ text: "once" }]);
  const gpt = client(fake);
  const first = await respondStep(step, "summarise", gpt, { input: "x" });
  const again = await respondStep(step, "summarise", gpt, { input: "x" });
  assert(first.ok && again.ok, "both ok");
  assertEquals([again.result.text, fake.requests.length], ["once", 1]);
  assertEquals(step.log, ["run summarise #1", "replay summarise"]);
});

Deno.test("transient failures throw so the step's own retries run", async () => {
  const step = fakeStep();
  const fake = new FakeResponses([jsonResponse({}, { status: 503 }), {
    text: "recovered",
  }]);
  const outcome = await respondStep(step, "s", client(fake), { input: "x" });
  assert(outcome.ok, "recovered");
  assertEquals(step.log.length, 3);
  assertEquals([step.log[0], step.log[2]], ["run s #1", "run s #2"]);
  assert(step.log[1].startsWith("threw GptError(server): "), step.log[1]);
});

Deno.test("permanent failures are stored as data", async () => {
  const step = fakeStep();
  const fake = new FakeResponses([
    jsonResponse({
      error: { type: "usage_limit_reached", resets_at: 2_000_000_000 },
    }, { status: 429 }),
  ]);
  const outcome = await respondStep(step, "s", client(fake), { input: "x" });
  assert(!outcome.ok, "failed");
  assertEquals([outcome.error.kind, step.log], ["usage_limit", ["run s #1"]]);
  // The reset is in 2033: past MAX_USAGE_RESET_WAIT_MS, so it is not slept
  // on (DB-SWP-F7-302); "waitForUsageReset checks the margin and refuses
  // absurd reset times" covers a reset it does sleep until.
  assertEquals(outcome.error.resetsAt, 2_000_000_000_000);
  const sleeper = fakeStep();
  assertEquals(
    await waitForUsageReset(sleeper, "wait", outcome.error, { marginMs: 5 }),
    false,
  );
  assertEquals(sleeper.log, []);
  assertEquals(
    await waitForUsageReset(sleeper, "no", {
      ...outcome.error,
      kind: "server",
    }),
    false,
  );
});

Deno.test("an agent run replays turns and tools without redoing them", async () => {
  let runs = 0;
  const count = functionTool({
    name: "count",
    description: "Counts.",
    parameters: v.object({}),
    run: () => String(++runs),
  });
  const fake = new FakeResponses([{
    toolCalls: [{ name: "count", arguments: {}, callId: "c1" }],
  }, { text: "counted" }]);
  const gpt = client(fake);
  const step = fakeStep();
  const start = () => new Conversation({ id: "wf-1" }).user("count once");
  const first = await runAgentWorkflow(step, "job", {
    client: gpt,
    conversation: start(),
    tools: new ToolRegistry([count]),
  });
  // A replay after suspension rebuilds the same conversation from stored steps.
  const replay = await runAgentWorkflow(step, "job", {
    client: gpt,
    conversation: start(),
    tools: new ToolRegistry([count]),
  });
  assertEquals([first.stopReason, replay.stopReason, replay.text], [
    "completed",
    "completed",
    "counted",
  ]);
  assertEquals([runs, fake.requests.length], [1, 2]);
  assertEquals(replay.conversation, first.conversation);
  // `count` mutates, so its batch has a start marker (DB-REV-OAI-5).
  assertEquals(step.log, [
    "run job:turn-0 #1",
    "run job:tools-0:start #1",
    "run job:tools-0 #1",
    "run job:turn-1 #1",
    "replay job:turn-0",
    "replay job:tools-0:start",
    "replay job:tools-0",
    "replay job:turn-1",
  ]);
});

Deno.test("a permanent failure mid-run ends the workflow run with the error", async () => {
  const fake = new FakeResponses([
    jsonResponse({ error: { code: "cyber_policy" } }, { status: 400 }),
  ]);
  const step = fakeStep();
  let error: unknown;
  try {
    await runAgentWorkflow(step, "job", {
      client: client(fake),
      conversation: new Conversation().user("x"),
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof GptError && error.kind === "policy", "policy");
});

Deno.test("step policies outlast the client's own retries", () => {
  assertEquals([DEFAULT_TURN_STEP.timeout, DEFAULT_TURN_STEP.retries?.limit], [
    "30 minutes",
    5,
  ]);
  assertEquals(DEFAULT_TOOLS_STEP.retries?.limit, 2);
});

// DB-REV-OAI-5: `retries.limit: 0` does not stop a replay: celld reruns
// `run` after an isolate dies, and a step with no stored result runs its
// callback again. A mutating batch that started and never recorded a
// result must not run its mutations again.
Deno.test("a mutating batch interrupted by a crash is not run again on replay", async () => {
  let runs = 0;
  const count = functionTool({
    name: "count",
    description: "Counts.",
    parameters: v.object({}),
    run: () => String(++runs),
  });
  let reads = 0;
  const peek = functionTool({
    name: "peek",
    description: "Reads.",
    parameters: v.object({}),
    mutates: false,
    run: () => `read ${++reads}`,
  });
  const fake = new FakeResponses([{
    toolCalls: [
      { name: "count", arguments: {}, callId: "c1" },
      { name: "peek", arguments: {}, callId: "c2" },
    ],
  }, { text: "done" }]);
  const gpt = client(fake);
  const inner = fakeStep();
  let crashed = false;
  // The first attempt at the batch dies after its callback ran, before
  // its result was stored, as an evicted isolate does.
  const step: WorkflowStep = {
    ...inner,
    do: (async (name: string, config: WorkflowStepConfig, callback: never) => {
      if (name === "job:tools-0" && !crashed) {
        crashed = true;
        await inner.do(`${name}#lost`, config, callback);
        throw new Error("isolate evicted");
      }
      return await inner.do(name, config, callback);
    }) as WorkflowStep["do"],
  };
  const start = () => new Conversation({ id: "wf-2" }).user("count once");
  let error: unknown;
  try {
    await runAgentWorkflow(step, "job", {
      client: gpt,
      conversation: start(),
      tools: new ToolRegistry([count, peek]),
    });
  } catch (caught) {
    error = caught;
  }
  assertEquals((error as Error).message, "isolate evicted");
  assertEquals([runs, reads], [1, 1]);
  const replay = await runAgentWorkflow(step, "job", {
    client: gpt,
    conversation: start(),
    tools: new ToolRegistry([count, peek]),
  });
  assertEquals([replay.stopReason, runs, reads], ["completed", 1, 2]);
  const outputs = fake.requests[1].body.input.filter((
    item: { type: string },
  ) => item.type === "function_call_output");
  assertEquals(outputs, [
    {
      type: "function_call_output",
      call_id: "c1",
      output:
        "error: not run: interrupted before its result was recorded; it may have run; check before repeating it",
    },
    { type: "function_call_output", call_id: "c2", output: "read 2" },
  ]);
});

// DB-SWP-F7-302 / F7-303: the reset time comes from the server and the
// margin from the caller; neither was checked before sleepUntil.
Deno.test("waitForUsageReset checks the margin and refuses absurd reset times", async () => {
  const base = {
    kind: "usage_limit" as const,
    message: "limit",
    retryable: false,
    status: 429,
    code: null,
    requestId: null,
    retryAfterMs: null,
    resetsAt: Date.now() + 60_000,
  };
  // deno-lint-ignore no-explicit-any
  const error = base as any;
  for (const marginMs of [NaN, -1, Infinity, 2 ** 31]) {
    let message = "";
    try {
      await waitForUsageReset(fakeStep(), "w", error, { marginMs });
    } catch (caught) {
      message = (caught as Error).message;
    }
    assert(message.includes("marginMs"), `${marginMs}: ${message}`);
  }
  for (const resetsAt of [Infinity, NaN, Date.now() + 30 * 86_400_000]) {
    const step = fakeStep();
    assertEquals(
      await waitForUsageReset(step, "w", { ...error, resetsAt }),
      false,
    );
    assertEquals(step.log, []);
  }
  const step = fakeStep();
  assertEquals(
    await waitForUsageReset(step, "w", error, { marginMs: 5 }),
    true,
  );
  assertEquals(step.log, [`sleepUntil w ${base.resetsAt + 5}`]);
});
