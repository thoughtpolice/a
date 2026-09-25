// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { JevClient } from "@celld/api/jev";
import {
  fakeBody,
  fakeFetch,
  jsonResponse,
  type RecordedRequest,
  virtualRuntime,
} from "@celld/api/jev/testing";
import {
  type ApprovalRequest,
  Conversation,
  functionTool,
  GptClient,
  runAgent,
  ToolRegistry,
} from "@celld/api/openai";
import {
  FakeResponses,
  virtualRuntime as gptRuntime,
} from "@celld/api/openai/testing";
import {
  jevApprover,
  needsEscalation,
  routeEffort,
  scoreOutput,
} from "@celld/api/openai/jev";
import { v } from "@celld/sieve";

function jev(
  answers: (
    request: RecordedRequest,
  ) => Record<string, Record<string, unknown>>,
) {
  const fetch = fakeFetch((request) =>
    jsonResponse(
      fakeBody(request.body.questions, { answers: answers(request) }),
    )
  );
  return {
    client: new JevClient({
      apiKey: "test",
      fetch,
      runtime: virtualRuntime(),
      retry: { maxRetries: 0 },
    }),
    fetch,
  };
}

function request(
  risk: "read" | "write" | "exec",
  args: unknown = { path: "x" },
): ApprovalRequest {
  return {
    call: {
      kind: "function",
      callId: "c1",
      name: "rm",
      arguments: JSON.stringify(args),
    },
    tool: {
      name: "rm",
      kind: "function",
      description: "Removes a file.",
      risk,
    },
    args: args as never,
    turn: 2,
  };
}

Deno.test("read-only calls are allowed without asking Jev", async () => {
  const { client, fetch } = jev(() => ({}));
  assertEquals(await jevApprover(client)(request("read")), true);
  assertEquals(fetch.calls.length, 0);
});

Deno.test("Jev's probability decides: allow, deny, or the uncertain middle", async () => {
  for (
    const [p, expected] of [
      [0.95, true],
      [0.1, { allow: false, reason: "judged unsafe (p(safe) = 0.10)" }],
      [0.5, { allow: false, reason: "needs human review (p(safe) = 0.50)" }],
    ] as const
  ) {
    const { client, fetch } = jev(() => ({ safe: { noul: p } }));
    assertEquals(
      await jevApprover(client, { task: "clean temp files" })(request("write")),
      expected,
    );
    const state = fetch.calls[0].body.state;
    assertEquals([state.task, state.tool.risk, state.call], [
      "clean temp files",
      "write",
      '{\n  "path": "x"\n}',
    ]);
  }
});

Deno.test("the uncertain middle can go to another approver", async () => {
  const { client } = jev(() => ({ safe: { noul: 0.5 } }));
  const human: string[] = [];
  const approve = jevApprover(client, {
    onUncertain: (req) => {
      human.push(req.tool.name);
      return true;
    },
  });
  assertEquals(await approve(request("exec")), true);
  assertEquals(human, ["rm"]);
  const allowing = jevApprover(client, {
    onUncertain: "allow",
    bands: { yes: 0.9, no: 0.1 },
  });
  assertEquals(await allowing(request("exec")), true);
});

Deno.test("a Jev failure denies by default", async () => {
  const fetch = fakeFetch(() =>
    jsonResponse({ detail: "down" }, { status: 500 })
  );
  const client = new JevClient({
    apiKey: "t",
    fetch,
    runtime: virtualRuntime(),
    retry: { maxRetries: 0 },
  });
  const denied = await jevApprover(client)(request("write"));
  assert(
    typeof denied === "object" && !denied.allow &&
      denied.reason.startsWith("the safety check failed"),
    JSON.stringify(denied),
  );
  assertEquals(
    await jevApprover(client, { onError: "allow" })(request("write")),
    true,
  );
});

Deno.test("an agent loop gated by Jev runs safe calls and refuses unsafe ones", async () => {
  const { client: gate } = jev((req) => ({
    safe: { noul: req.body.state.call.includes("prod") ? 0.05 : 0.97 },
  }));
  const remove = functionTool({
    name: "remove",
    description: "Deletes a key.",
    parameters: v.object({ key: v.string() }),
    risk: "write",
    run: ({ key }) => `removed ${key}`,
  });
  const fake = new FakeResponses([
    {
      toolCalls: [
        { name: "remove", arguments: { key: "tmp-1" }, callId: "a" },
        { name: "remove", arguments: { key: "prod-db" }, callId: "b" },
      ],
    },
    { text: "removed tmp-1; prod-db needs a human" },
  ]);
  const gpt = new GptClient({
    fetch: fake.fetch,
    runtime: gptRuntime(),
    model: "gpt-5.5",
  });
  const result = await runAgent({
    client: gpt,
    conversation: new Conversation().user("clean up"),
    tools: new ToolRegistry([remove]),
    approve: jevApprover(gate, { task: "clean up temporary keys" }),
  });
  assertEquals(result.stopReason, "completed");
  const outputs = fake.requests[1].body.input.filter((item: { type: string }) =>
    item.type === "function_call_output"
  );
  assertEquals(outputs.map((item: { output: string }) => item.output), [
    "removed tmp-1",
    "denied: judged unsafe (p(safe) = 0.05)",
  ]);
});

Deno.test("routeEffort picks an effort, falling back below the floor", async () => {
  const confident = jev(() => ({
    effort: {
      choice: "high",
      probabilities: { low: 0.05, medium: 0.05, high: 0.8, xhigh: 0.1 },
      confidence: 0.8,
    },
  }));
  assertEquals(
    await routeEffort(
      confident.client,
      "Find the race in this lock-free queue.",
    ),
    {
      effort: "high",
      confidence: 0.8,
      decided: true,
    },
  );
  const criteria = confident.fetch.calls[0].body.questions.effort.criteria;
  assertEquals(Object.keys(criteria), ["low", "medium", "high", "xhigh"]);
  const unsure = jev(() => ({
    effort: {
      choice: "low",
      probabilities: { low: 0.3, medium: 0.25, high: 0.25, xhigh: 0.2 },
      confidence: 0.2,
    },
  }));
  assertEquals(
    await routeEffort(unsure.client, { task: "?" }, { fallback: "xhigh" }),
    {
      effort: "xhigh",
      confidence: 0.2,
      decided: false,
    },
  );
});

Deno.test("needsEscalation bands the probability", async () => {
  const { client, fetch } = jev(() => ({ escalate: { noul: 0.85 } }));
  assertEquals(
    await needsEscalation(client, "RCE on the payment API", {
      context: "internet facing",
    }),
    {
      escalate: "yes",
      probability: 0.85,
    },
  );
  assertEquals(fetch.calls[0].body.state, {
    context: "internet facing",
    finding: "RCE on the payment API",
  });
});

Deno.test("scoreOutput normalises the rubric score", async () => {
  const { client, fetch } = jev(() => ({
    quality: {
      score: 3,
      probabilities: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0 },
      confidence: 0.9,
    },
  }));
  assertEquals(
    await scoreOutput(client, { task: "fix the bug", output: "patched" }),
    {
      score: 0.75,
      level: 3,
      confidence: 0.9,
    },
  );
  assertEquals(fetch.calls[0].body.questions.quality.criteria.length, 5);
});
