// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  Conversation,
  type ConversationData,
  type ConversationsApi,
  durableConversationStore,
  functionOutput,
  GptClient,
  GptDecodeError,
  GptError,
  kvConversationStore,
  memoryConversationStore,
} from "@celld/api/openai";
import { FakeResponses, virtualRuntime } from "@celld/api/openai/testing";

function client(fake: FakeResponses) {
  return new GptClient({ fetch: fake.fetch, runtime: virtualRuntime() });
}

Deno.test("each turn replays everything before it, encrypted reasoning included", async () => {
  const fake = new FakeResponses([
    {
      id: "r1",
      reasoning: "plan",
      encrypted: "ENC-1",
      toolCalls: [{ name: "f", arguments: { x: 1 }, callId: "c1" }],
    },
    { id: "r2", reasoning: "done", encrypted: "ENC-2", text: "final" },
  ]);
  const gpt = client(fake);
  const thread = new Conversation({
    id: "conv-7",
    instructions: "Be terse.",
    model: "gpt-5.5",
  }).user("go");
  thread.record(await gpt.respond(thread.request()));
  assertEquals(thread.pendingCalls().map((call) => call.callId), ["c1"]);
  thread.push(functionOutput("c1", "42"));
  thread.record(await gpt.respond(thread.request()));
  assertEquals(thread.lastText, "final");
  const second = fake.requests[1].body;
  assertEquals([second.instructions, second.model, second.prompt_cache_key], [
    "Be terse.",
    "gpt-5.5",
    "conv-7",
  ]);
  assertEquals(fake.requests[1].headers.get("session-id"), "conv-7");
  assertEquals(second.input, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "go" }],
    },
    {
      type: "reasoning",
      id: "rs_r1_0",
      summary: [{ type: "summary_text", text: "plan" }],
      encrypted_content: "ENC-1",
    },
    {
      type: "function_call",
      id: "fc_r1_1",
      call_id: "c1",
      name: "f",
      arguments: '{"x":1}',
    },
    { type: "function_call_output", call_id: "c1", output: "42" },
  ]);
  assertEquals([thread.turns, thread.usage.totalTokens], [2, 240]);
});

Deno.test("reasoning without encrypted content is not replayed", () => {
  const thread = new Conversation().push(
    { type: "reasoning", summary: [], encrypted_content: null },
    { type: "reasoning", summary: [], encrypted_content: "keep" },
  );
  assertEquals(
    thread.replay().map((item) =>
      item.type === "reasoning" && item.encrypted_content
    ),
    ["keep"],
  );
  assertEquals(thread.items.length, 2);
});

Deno.test("a conversation round-trips through JSON and resumes", async () => {
  const fake = new FakeResponses([{ id: "a", encrypted: "E", text: "one" }, {
    text: "two",
  }]);
  const gpt = client(fake);
  const thread = new Conversation({ instructions: "i", model: "gpt-5.5" }).user(
    "hello",
  );
  thread.record(await gpt.respond(thread.request()));
  const stored = JSON.parse(JSON.stringify(thread.toJSON()));
  const resumed = Conversation.fromJSON(stored).user("again");
  assertEquals([resumed.id, resumed.instructions, resumed.turns], [
    thread.id,
    "i",
    1,
  ]);
  await gpt.respond(resumed.request());
  assertEquals(fake.requests[1].body.input.length, 4);
  assertEquals(fake.requests[1].body.prompt_cache_key, thread.id);
});

Deno.test("fromJSON reports every problem with its path", () => {
  let error: unknown;
  try {
    Conversation.fromJSON({
      version: 2,
      id: "",
      instructions: 3,
      model: null,
      items: [{ type: "message", role: "x", content: "y" }],
      usage: {},
      turns: -1,
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof GptDecodeError, "decode error");
  assertEquals(
    (error as GptDecodeError).issues.map((issue) => issue.path.join(".")),
    [
      "version",
      "id",
      "instructions",
      "items.0.role",
      "usage",
      "turns",
    ],
  );
});

Deno.test("push refuses malformed items and kinds that are not replayed", () => {
  let error: unknown;
  try {
    new Conversation().push({
      type: "function_call",
      call_id: "",
      name: "f",
      arguments: "{}",
    });
  } catch (caught) {
    error = caught;
  }
  assert(
    error instanceof GptError && error.kind === "invalid_request",
    "invalid",
  );
  let other: unknown;
  try {
    new Conversation().push({ type: "web_search_call" } as never);
  } catch (caught) {
    other = caught;
  }
  assert(other instanceof GptError, "unknown kinds are refused");
});

Deno.test("fork copies without sharing", () => {
  const thread = new Conversation({ id: "a" }).user("x");
  const copy = thread.fork("b");
  copy.user("y");
  assertEquals([thread.items.length, copy.items.length, copy.id], [1, 2, "b"]);
  assert(new Conversation().id !== new Conversation().id, "fresh ids differ");
});

Deno.test("request extras override defaults but never the input", () => {
  const thread = new Conversation({ id: "c", model: "m" }).user("x");
  const request = thread.request({
    model: "other",
    reasoning: { effort: "high" },
  });
  assertEquals([
    request.model,
    request.promptCacheKey,
    request.reasoning?.effort,
    (request.input as unknown[]).length,
  ], [
    "other",
    "c",
    "high",
    1,
  ]);
});

Deno.test("the memory store clones in and out", async () => {
  const store = memoryConversationStore();
  const data = new Conversation({ id: "m" }).user("x").toJSON();
  await store.save(data);
  const loaded = await store.load("m");
  assertEquals(loaded, data);
  assert(loaded !== data, "a copy");
  await store.delete("m");
  assertEquals([await store.load("m"), store.size], [null, 0]);
});

Deno.test("the KV store keys by prefix, sets a TTL, and validates on load", async () => {
  const puts: [string, string, unknown][] = [];
  const values = new Map<string, string>();
  const kv = {
    get: (key: string) => Promise.resolve(values.get(key) ?? null),
    put: (key: string, value: string, options?: unknown) => {
      puts.push([key, value, options]);
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      values.delete(key);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
  const store = kvConversationStore(kv, { ttlSeconds: 60 });
  await store.save(new Conversation({ id: "k" }).user("x").toJSON());
  assertEquals([puts[0][0], puts[0][2]], ["gpt/conversation/k", {
    expirationTtl: 60,
  }]);
  assertEquals((await store.load("k"))?.items.length, 1);
  values.set("gpt/conversation/bad", JSON.stringify({ version: 1 }));
  let error: unknown;
  try {
    await store.load("bad");
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof GptDecodeError, "corrupt data is refused");
});

Deno.test("the durable store forwards to the named object", async () => {
  const calls: unknown[] = [];
  const saved = new Map<string, ConversationData>();
  const stub: Partial<ConversationsApi> = {
    load: (id) => {
      calls.push(["load", id]);
      return saved.get(id) ?? null;
    },
    save: (data) => {
      calls.push(["save", data.id]);
      saved.set(data.id, data);
      return Promise.resolve();
    },
    remove: (id) => {
      calls.push(["remove", id]);
      saved.delete(id);
      return Promise.resolve();
    },
  };
  const names: string[] = [];
  const namespace = {
    getByName(name: string) {
      names.push(name);
      return stub;
    },
  } as unknown as DurableObjectNamespace<ConversationsApi>;
  const store = durableConversationStore(namespace, "tenant-1");
  await store.save(new Conversation({ id: "d" }).toJSON());
  assertEquals((await store.load("d"))?.id, "d");
  await store.delete("d");
  assertEquals(calls, [["save", "d"], ["load", "d"], ["remove", "d"]]);
  assertEquals(names, ["tenant-1", "tenant-1", "tenant-1"]);
});
