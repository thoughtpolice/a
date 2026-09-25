// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import type { SseEvent } from "@celld/http/sse";
import {
  accumulateResponseObject,
  GptDecodeError,
  ResponseAccumulator,
  type StreamEvent,
  type TurnMeta,
} from "@celld/api/openai";
import { turnEvents } from "@celld/api/openai/testing";

const meta: TurnMeta = {
  attempts: 1,
  latencyMs: 0,
  requestId: null,
  promptCacheKey: "k",
  encoding: "standard",
  rateLimits: [],
};

function sse(data: unknown): SseEvent {
  return {
    event: "message",
    data: JSON.stringify(data),
    id: null,
    retry: null,
  };
}

function feed(events: unknown[]) {
  const accumulator = new ResponseAccumulator("req-1");
  const out: StreamEvent[] = [];
  for (const event of events) out.push(...accumulator.handle(sse(event)));
  return { accumulator, out };
}

Deno.test("a full response becomes a turn with text, reasoning, calls and usage", () => {
  const events = turnEvents({
    id: "resp_1",
    reasoning: "thinking about it",
    text: ["Hel", "lo"],
    phase: "final_answer",
    toolCalls: [{ name: "f", arguments: { a: 1 }, callId: "call_1" }, {
      name: "apply_patch",
      input: "*** Begin Patch",
      callId: "call_2",
    }],
    usage: { input: 1000, cached: 800, output: 50, reasoning: 30 },
    endTurn: false,
  });
  const { accumulator, out } = feed(events);
  assertEquals(accumulator.state, "completed");
  const turn = accumulator.turn("gpt-6-astra", meta);
  assertEquals([
    turn.id,
    turn.text,
    turn.finalText,
    turn.servedModel,
    turn.endTurn,
  ], [
    "resp_1",
    "Hello",
    "Hello",
    "gpt-6-astra",
    false,
  ]);
  assertEquals(turn.reasoningSummary, ["thinking about it"]);
  assertEquals(turn.output.map((item) => item.type), [
    "reasoning",
    "message",
    "function_call",
    "custom_tool_call",
  ]);
  assertEquals(turn.output[0], {
    type: "reasoning",
    id: "rs_resp_1_0",
    summary: [{ type: "summary_text", text: "thinking about it" }],
    encrypted_content: "enc_resp_1",
  });
  // Output-only fields (status, annotations) are dropped, as Codex does.
  assertEquals(turn.output[1], {
    type: "message",
    id: "msg_resp_1_1",
    role: "assistant",
    content: [{ type: "output_text", text: "Hello" }],
    phase: "final_answer",
  });
  assertEquals(turn.toolCalls, [
    { kind: "function", callId: "call_1", name: "f", arguments: '{"a":1}' },
    {
      kind: "custom",
      callId: "call_2",
      name: "apply_patch",
      input: "*** Begin Patch",
    },
  ]);
  assertEquals(turn.usage, {
    inputTokens: 1000,
    cachedInputTokens: 800,
    outputTokens: 50,
    reasoningTokens: 30,
    totalTokens: 1050,
  });
  assertEquals(
    out.filter((event) => event.type === "text.delta").map((event) =>
      (event as { delta: string }).delta
    ),
    ["Hel", "lo"],
  );
  const tool = out.find((event) =>
    event.type === "tool.delta" && event.kind === "function"
  );
  assertEquals(tool, {
    type: "tool.delta",
    kind: "function",
    itemId: "fc_resp_1_2",
    callId: "call_1",
    name: "f",
    delta: '{"a',
  });
  assert(
    out.some((event) => event.type === "reasoning.done"),
    "reasoning.done surfaced",
  );
});

Deno.test("items are ordered by output_index, not arrival", () => {
  const { accumulator } = feed([
    { type: "response.created", response: { id: "r" } },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "second" }],
      },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "first" }],
      },
    },
    { type: "response.completed", response: { id: "r" } },
  ]);
  const turn = accumulator.turn("m", meta);
  assertEquals(turn.text, "first\n\nsecond");
  assertEquals([turn.usageReported, turn.usage.totalTokens], [false, 0]);
});

Deno.test("items missing their done event are rebuilt from added and deltas", () => {
  const { accumulator } = feed([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "m1", type: "message", role: "assistant", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "m1",
      output_index: 0,
      delta: "par",
    },
    {
      type: "response.output_text.delta",
      item_id: "m1",
      output_index: 0,
      delta: "tial",
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "f1",
        type: "function_call",
        call_id: "c",
        name: "f",
        arguments: "",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "f1",
      output_index: 1,
      delta: "{}",
    },
    {
      type: "response.completed",
      response: { id: "r", usage: { input_tokens: 5, output_tokens: 1 } },
    },
  ]);
  const turn = accumulator.turn("m", meta);
  assertEquals(turn.text, "partial");
  assertEquals(turn.toolCalls, [{
    kind: "function",
    callId: "c",
    name: "f",
    arguments: "{}",
  }]);
  assertEquals(turn.usage.totalTokens, 6);
});

Deno.test("response.completed output fills in items the stream never sent", () => {
  const events = turnEvents({ id: "r2", text: "from completed" }).filter((
    event,
  ) => !String(event.type).startsWith("response.output_item"));
  const { accumulator } = feed(events);
  assertEquals(accumulator.turn("m", meta).text, "from completed");
});

Deno.test("response.failed ends with a classified error", () => {
  const { accumulator } = feed(
    turnEvents({
      status: "failed",
      error: { code: "context_length_exceeded", message: "too long" },
    }),
  );
  assertEquals(accumulator.state, "failed");
  assertEquals([accumulator.error?.kind, accumulator.error?.requestId], [
    "context_window",
    "req-1",
  ]);
});

Deno.test("response.incomplete ends with its reason, and reports usage", () => {
  const { accumulator } = feed(
    turnEvents({
      text: "cut",
      status: "incomplete",
      incompleteReason: "content_filter",
    }),
  );
  assertEquals(accumulator.state, "incomplete");
  assertEquals([
    accumulator.error?.kind,
    accumulator.error?.code,
    accumulator.error?.retryable,
  ], [
    "incomplete",
    "content_filter",
    false,
  ]);
  assertEquals(accumulator.usage?.inputTokens, 100);
});

Deno.test("an error event is remembered but does not end the stream", () => {
  const { accumulator } = feed([{
    type: "error",
    code: "rate_limit_exceeded",
    message: "try again in 2s",
    param: null,
  }]);
  assertEquals(accumulator.state, "open");
  assertEquals([
    accumulator.pendingError?.kind,
    accumulator.pendingError?.retryAfterMs,
  ], ["rate_limited", 2000]);
});

Deno.test("events after the end, non-JSON data and unknown types are ignored", () => {
  const accumulator = new ResponseAccumulator();
  accumulator.handle({
    event: "message",
    data: "not json",
    id: null,
    retry: null,
  });
  accumulator.handle(sse({ type: "response.brand_new_event", x: 1 }));
  accumulator.handle(
    sse({ type: "response.completed", response: { id: "r" } }),
  );
  assertEquals(
    accumulator.handle(
      sse({ type: "response.output_text.delta", delta: "late" }),
    ),
    [],
  );
  assertEquals([accumulator.skipped, accumulator.state], [1, "completed"]);
});

Deno.test("codex.rate_limits events update the snapshot", () => {
  const { accumulator, out } = feed([
    {
      type: "codex.rate_limits",
      plan_type: "pro",
      rate_limits: {
        primary: {
          used_percent: 42,
          window_minutes: 300,
          reset_at: 1_900_000_000,
        },
      },
    },
    { type: "response.completed", response: { id: "r" } },
  ]);
  assertEquals(out[0].type, "rate_limits");
  const turn = accumulator.turn("m", meta);
  assertEquals(
    turn.meta.rateLimits.map((
      snapshot,
    ) => [snapshot.limitId, snapshot.primary?.usedPercent, snapshot.planType]),
    [
      ["codex", 42, "pro"],
    ],
  );
});

Deno.test("a malformed known item is a decode error with its path", () => {
  const { accumulator } = feed([
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", name: "f", arguments: "{}" },
    },
    { type: "response.completed", response: { id: "r" } },
  ]);
  let error: unknown;
  try {
    accumulator.turn("m", meta);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof GptDecodeError, "decode error");
  assertEquals((error as GptDecodeError).issues[0].path, [
    "output",
    0,
    "call_id",
  ]);
});

Deno.test("unknown output item kinds are kept aside, not replayed", () => {
  const { accumulator } = feed([
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "web_search_call", id: "ws", status: "completed" },
    },
    { type: "response.completed", response: { id: "r" } },
  ]);
  const turn = accumulator.turn("m", meta);
  assertEquals([turn.output.length, turn.otherOutput.length], [0, 1]);
});

Deno.test("a refusal is surfaced on the turn", () => {
  const { accumulator, out } = feed(
    turnEvents({ refusal: "I can't help with that." }),
  );
  assertEquals(accumulator.turn("m", meta).refusal, "I can't help with that.");
  assert(out.some((event) => event.type === "refusal.delta"), "refusal delta");
});

Deno.test("a non-streaming response object is accepted", () => {
  const accumulator = accumulateResponseObject({
    id: "resp_json",
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "plain" }],
    }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  }, null);
  const turn = accumulator.turn("m", meta);
  assertEquals([turn.id, turn.text, turn.usage.totalTokens], [
    "resp_json",
    "plain",
    5,
  ]);
  assertEquals(
    accumulateResponseObject({ status: "failed", error: { code: "x" } }, null)
      .state,
    "failed",
  );
});

Deno.test("access programs are read from the response and kept on the turn", () => {
  // As gpt-daybreak-blue-latest answers through a ChatGPT subscription.
  const response = (status: string, programs: unknown) => ({
    id: "resp_db",
    model: "gpt-daybreak-blue-latest",
    status,
    access_programs: programs,
    output: [],
  });
  const { accumulator } = feed([
    {
      type: "response.created",
      response: response("in_progress", { cyber: "daybreak_blue" }),
    },
    {
      type: "response.completed",
      response: {
        ...response("completed", { cyber: "daybreak_blue", other: 1 }),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
  const turn = accumulator.turn("gpt-daybreak-blue-latest", meta);
  assertEquals(turn.accessPrograms, { cyber: "daybreak_blue" });
  assertEquals(turn.servedModel, "gpt-daybreak-blue-latest");

  // gpt-5.6-sol reports `access_programs: null`.
  const plain = feed(turnEvents({ text: "hi" })).accumulator.turn(
    "gpt-5.6-sol",
    meta,
  );
  assertEquals(plain.accessPrograms, null);
});
