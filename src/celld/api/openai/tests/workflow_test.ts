// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
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
  const sleeper = fakeStep();
  assertEquals(
    await waitForUsageReset(sleeper, "wait", outcome.error, { marginMs: 5 }),
    true,
  );
  assertEquals(sleeper.log, ["sleepUntil wait 2000000000005"]);
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
  assertEquals(step.log, [
    "run job:turn-0 #1",
    "run job:tools-0 #1",
    "run job:turn-1 #1",
    "replay job:turn-0",
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
