// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  GptClient,
  type GptClientOptions,
  GptError,
  GptOutputError,
  integrationBaseUrl,
  memoryPacer,
  type RetryEvent,
  type StreamEvent,
  strictSchema,
} from "@celld/api/openai";
import {
  FakeResponses,
  jsonResponse,
  type ScriptStep,
  sseResponse,
  turnEvents,
  virtualRuntime,
} from "@celld/api/openai/testing";
import { v } from "@celld/sieve";

function setup(script: ScriptStep[], options: Partial<GptClientOptions> = {}) {
  const fake = new FakeResponses(script);
  const runtime = virtualRuntime();
  const retries: RetryEvent[] = [];
  const gpt = new GptClient({
    fetch: fake.fetch,
    runtime,
    onRetry: (event) => retries.push(event),
    ...options,
  });
  return { fake, gpt, runtime, retries };
}

async function failure(promise: Promise<unknown>): Promise<GptError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GptError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

function status(
  code: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(body, { status: code, headers });
}

Deno.test("integration base URLs: personal, team, routing and overrides", () => {
  assertEquals(integrationBaseUrl(), "https://llm.int.exe.xyz/openai/v1");
  assertEquals(
    integrationBaseUrl("chatgpt-llm", { team: true }),
    "https://chatgpt-llm.team.exe.xyz/openai/v1",
  );
  assertEquals(
    integrationBaseUrl("llm", { route: "auto" }),
    "https://llm.int.exe.xyz/v1",
  );
  assertEquals(
    integrationBaseUrl("llm", { domain: "int.test", scheme: "http" }),
    "http://llm.int.test/openai/v1",
  );
  let message = "";
  try {
    integrationBaseUrl("bad name");
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message, 'integration name "bad name" is not a hostname label');
});

Deno.test("fromEnv reads the base URL, integration, team flag and model", () => {
  assertEquals(
    GptClient.fromEnv({}).baseUrl,
    "https://llm.int.exe.xyz/openai/v1",
  );
  const team = GptClient.fromEnv({
    EXE_LLM_INTEGRATION: "gpt",
    EXE_LLM_TEAM: "true",
    OPENAI_MODEL: "gpt-6-sol",
  });
  assertEquals([team.baseUrl, team.model], [
    "https://gpt.team.exe.xyz/openai/v1",
    "gpt-6-sol",
  ]);
  const explicit = GptClient.fromEnv({
    OPENAI_BASE_URL: "http://127.0.0.1:9/v1/",
  }, { model: "m" });
  assertEquals([explicit.baseUrl, explicit.model], [
    "http://127.0.0.1:9/v1",
    "m",
  ]);
  assertEquals(new GptClient().model, "gpt-6-astra");
});

Deno.test("the constructor refuses bad settings", () => {
  const messages: string[] = [];
  for (
    const options of [
      { baseUrl: "ftp://x" },
      { baseUrl: "not a url" },
      { model: " " },
      { idleTimeoutMs: 0 },
    ] as GptClientOptions[]
  ) {
    try {
      new GptClient(options);
    } catch (error) {
      messages.push((error as Error).message);
    }
  }
  assertEquals(messages, [
    "baseUrl must be http(s), got ftp://x",
    "baseUrl is not a URL: not a url",
    "model must not be blank",
    "idleTimeoutMs must be a positive number, got 0",
  ]);
});

Deno.test("respond streams a turn and sends what Codex sends", async () => {
  const { fake, gpt } = setup([{
    text: "hello",
    reasoning: "r",
    usage: { input: 10, output: 2 },
  }]);
  const turn = await gpt.respond({ input: "hi", promptCacheKey: "conv-1" });
  assertEquals([
    turn.finalText,
    turn.meta.attempts,
    turn.meta.promptCacheKey,
    turn.meta.encoding,
  ], [
    "hello",
    1,
    "conv-1",
    "lite",
  ]);
  assertEquals(turn.usage.totalTokens, 12);
  const [request] = fake.requests;
  assertEquals(request.url, "https://llm.int.exe.xyz/openai/v1/responses");
  assertEquals(request.headers.get("accept"), "text/event-stream");
  assertEquals(request.headers.get("session-id"), "conv-1");
  assertEquals(request.headers.get("user-agent"), "celld-openai/0.1.0");
  assertEquals(request.headers.get("authorization"), null);
  assertEquals([request.body.stream, request.body.store, request.body.model], [
    true,
    false,
    "gpt-6-astra",
  ]);
});

Deno.test("stream yields events, then result and text resolve", async () => {
  const { gpt } = setup([{
    text: ["a", "b", "c"],
    toolCalls: [{ name: "f", arguments: {} }],
  }]);
  const stream = gpt.stream({ input: "hi" });
  const types: string[] = [];
  for await (const event of stream) types.push(event.type);
  assertEquals(types.filter((type) => type === "text.delta").length, 3);
  assertEquals(types[types.length - 1], "completed");
  assertEquals(await stream.text(), "abc");
  assertEquals((await stream.result).toolCalls.length, 1);
});

Deno.test("result drains a stream nobody iterates", async () => {
  const { gpt } = setup([{ text: "drained" }]);
  assertEquals((await gpt.stream({ input: "x" }).result).text, "drained");
});

Deno.test("a stream split into tiny byte chunks gives the same turn", async () => {
  const { gpt } = setup([{
    text: "héllo wörld 🌍",
    reasoning: "✓",
    chunkSize: 3,
  }]);
  const turn = await gpt.respond({ input: "x" });
  assertEquals([turn.text, turn.reasoningSummary], ["héllo wörld 🌍", ["✓"]]);
});

Deno.test("5xx is retried with backoff, then succeeds", async () => {
  const { gpt, runtime, retries } = setup([
    status(500, { error: { message: "oops" } }),
    status(502, "bad gateway"),
    { text: "ok" },
  ]);
  const turn = await gpt.respond({ input: "x" });
  assertEquals([turn.text, turn.meta.attempts], ["ok", 3]);
  assertEquals(runtime.sleeps, [450, 900]);
  assertEquals(retries.map((event) => event.error.kind), ["server", "server"]);
});

Deno.test("retry-after is honoured on 429", async () => {
  const { gpt, runtime } = setup([
    status(429, {
      error: { code: "rate_limit_exceeded", message: "slow down" },
    }, { "retry-after": "3" }),
    { text: "ok" },
  ]);
  await gpt.respond({ input: "x" });
  assertEquals(runtime.sleeps, [3000]);
});

Deno.test("a usage limit is not retried and says when it resets", async () => {
  const { fake, gpt } = setup([
    status(429, {
      error: {
        type: "usage_limit_reached",
        message: "limit",
        resets_at: 1_760_000_000,
      },
    }),
  ]);
  const error = await failure(gpt.respond({ input: "x" }));
  assertEquals([
    error.kind,
    error.resetsAt,
    error.attempts,
    fake.requests.length,
  ], [
    "usage_limit",
    1_760_000_000_000,
    1,
    1,
  ]);
});

Deno.test("a stream cut short is retried by respond", async () => {
  const { gpt } = setup([{ text: "partial answer", cutAfter: 5 }, {
    text: "whole answer",
  }]);
  const turn = await gpt.respond({ input: "x" });
  assertEquals([turn.text, turn.meta.attempts], ["whole answer", 2]);
});

Deno.test("stream() retries before output, announcing it", async () => {
  const { gpt } = setup([{ text: "never", cutAfter: 2 }, { text: "second" }]);
  const events: StreamEvent[] = [];
  for await (const event of gpt.stream({ input: "x" })) events.push(event);
  const retry = events.find((event) => event.type === "retry");
  assert(retry !== undefined && retry.type === "retry", "a retry event");
  assertEquals([retry.attempt, retry.error.kind], [1, "stream"]);
  assertEquals(events[events.length - 1].type, "completed");
});

Deno.test("stream() does not retry once output has been handed out", async () => {
  const { fake, gpt } = setup([{ text: ["a", "b"], cutAfter: 6 }, {
    text: "unused",
  }]);
  const seen: string[] = [];
  const error = await failure((async () => {
    for await (const event of gpt.stream({ input: "x" })) seen.push(event.type);
  })());
  assertEquals([error.kind, error.retryable, fake.requests.length], [
    "stream",
    true,
    1,
  ]);
  assert(seen.includes("text.delta"), "output was seen");
  assert(
    error.message.includes("ended before response.completed"),
    error.message,
  );
});

Deno.test("response.failed with a rate limit waits as the message says", async () => {
  const { gpt, runtime } = setup([
    {
      status: "failed",
      error: {
        code: "rate_limit_exceeded",
        message: "Please try again in 1.5s.",
      },
    },
    { text: "ok" },
  ]);
  await gpt.respond({ input: "x" });
  assertEquals(runtime.sleeps, [1500]);
});

Deno.test("response.incomplete is thrown, not retried", async () => {
  const { fake, gpt } = setup([{ text: "half", status: "incomplete" }]);
  const error = await failure(gpt.respond({ input: "x" }));
  assertEquals([error.kind, error.code, fake.requests.length], [
    "incomplete",
    "max_output_tokens",
    1,
  ]);
});

Deno.test("policy refusals are thrown, not retried", async () => {
  const { fake, gpt } = setup([
    status(400, { error: { code: "cyber_policy", message: "flagged" } }),
  ]);
  const error = await failure(gpt.respond({ input: "x" }));
  assertEquals([error.kind, error.code, fake.requests.length], [
    "policy",
    "cyber_policy",
    1,
  ]);
});

Deno.test("connection failures are retried", async () => {
  const { gpt } = setup([new TypeError("connection reset"), { text: "ok" }]);
  const turn = await gpt.respond({ input: "x" });
  assertEquals(turn.meta.attempts, 2);
});

Deno.test("retries stop at maxRetries with the last error", async () => {
  const { gpt } = setup([
    new TypeError("down"),
    new TypeError("down"),
    new TypeError("still down"),
  ], {
    retry: { maxRetries: 2 },
  });
  const error = await failure(gpt.respond({ input: "x" }));
  assertEquals([error.kind, error.attempts], ["connection", 3]);
  assert(error.message.includes("still down"), error.message);
});

Deno.test("a retry that would pass the budget is not started", async () => {
  const { fake, gpt } = setup([status(503, {}, { "retry-after": "10" }), {
    text: "unused",
  }], {
    retry: { budgetMs: 5000 },
  });
  const error = await failure(gpt.respond({ input: "x" }));
  assertEquals([error.kind, fake.requests.length], ["server", 1]);
});

Deno.test("an idle stream times out", async () => {
  const stalled = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${
                JSON.stringify({
                  type: "response.created",
                  response: { id: "r" },
                })
              }\n\n`,
            ),
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const { gpt } = setup([stalled], {
    idleTimeoutMs: 50,
    retry: { maxRetries: 0 },
  });
  const error = await failure(gpt.respond({ input: "x" }));
  assertEquals([error.kind, error.message], [
    "timeout",
    "no stream event within 50 ms",
  ]);
});

Deno.test("no response headers in time is a timeout", async () => {
  const fetch = () => new Promise<Response>(() => {});
  const gpt = new GptClient({
    fetch,
    runtime: virtualRuntime(),
    connectTimeoutMs: 30,
    retry: { maxRetries: 0 },
  });
  const error = await failure(gpt.respond({ input: "x" }));
  assertEquals(error.kind, "timeout");
  assert(error.message.includes("within 30 ms"), error.message);
});

Deno.test("aborting cancels the call", async () => {
  const controller = new AbortController();
  const fetch = (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
    );
  const gpt = new GptClient({ fetch, runtime: virtualRuntime() });
  const pending = gpt.respond({ input: "x" }, { signal: controller.signal });
  controller.abort();
  const error = await failure(pending);
  assertEquals([error.kind, error.retryable], ["aborted", false]);
  const already = await failure(
    gpt.respond({ input: "x" }, { signal: AbortSignal.abort() }),
  );
  assertEquals(already.kind, "aborted");
});

Deno.test("breaking out of a stream cancels the request", async () => {
  let signal: AbortSignal | null = null;
  const { gpt } = setup([(request) => {
    signal = request.signal;
    return sseResponse(turnEvents({ text: ["a", "b", "c"] }), { delayMs: 5 });
  }]);
  for await (const event of gpt.stream({ input: "x" })) {
    if (event.type === "text.delta") break;
  }
  assert(
    signal !== null && (signal as AbortSignal).aborted,
    "the fetch was aborted",
  );
});

Deno.test("an invalid request is refused before any fetch", async () => {
  const { fake, gpt } = setup([]);
  const error = await failure(gpt.respond({ input: "" }));
  assertEquals([error.kind, error.issues.length, fake.fetch.calls.length], [
    "invalid_request",
    1,
    0,
  ]);
});

Deno.test("tryRespond returns failures as plain data", async () => {
  const { gpt } = setup([status(401, { error: { message: "who?" } })]);
  const outcome = await gpt.tryRespond({ input: "x" });
  assert(!outcome.ok, "failed");
  assertEquals([
    outcome.error.kind,
    outcome.error.status,
    outcome.error.retryable,
  ], ["authentication", 401, false]);
  assertEquals(JSON.parse(JSON.stringify(outcome)), outcome);
});

Deno.test("rate-limit headers and the served model are reported", async () => {
  const seen: unknown[] = [];
  const { gpt } = setup([{
    text: "x",
    headers: {
      "x-codex-primary-used-percent": "12.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1760000000",
      "openai-model": "gpt-6-astra-2026-09-01",
      "x-request-id": "req-9",
    },
  }], { onRateLimits: (limits) => seen.push(limits) });
  const turn = await gpt.respond({ input: "x" });
  assertEquals(turn.servedModel, "gpt-6-astra-2026-09-01");
  assertEquals(turn.meta.requestId, "req-9");
  assertEquals(turn.meta.rateLimits[0].primary, {
    usedPercent: 12.5,
    windowMinutes: 300,
    resetsAt: 1_760_000_000_000,
  });
  assertEquals(seen.length, 1);
});

Deno.test("a JSON answer from a non-streaming proxy is accepted", async () => {
  const { gpt } = setup([jsonResponse({
    id: "resp_j",
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "json" }],
    }],
  })]);
  assertEquals((await gpt.respond({ input: "x" })).text, "json");
});

Deno.test("ask returns the final text", async () => {
  const { gpt } = setup([{ text: "answer", phase: "final_answer" }]);
  assertEquals(await gpt.ask("q", { reasoning: { effort: "low" } }), "answer");
});

Deno.test("structured decodes typed output", async () => {
  const schema = v.object({
    verdict: v.enum(["yes", "no"]),
    score: v.number(),
  });
  const { fake, gpt } = setup([{
    text: JSON.stringify({ verdict: "yes", score: 0.9 }),
  }]);
  const { value } = await gpt.structured({
    input: "x",
    schema,
    name: "verdict",
  });
  const verdict: "yes" | "no" = value.verdict;
  assertEquals([verdict, value.score], ["yes", 0.9]);
  assertEquals(fake.requests[0].body.text.format, {
    type: "json_schema",
    name: "verdict",
    schema: strictSchema(schema),
    strict: true,
  });
});

Deno.test("structured reports schema mismatches with paths, and refusals", async () => {
  const schema = v.strictObject({ verdict: v.enum(["yes", "no"]) });
  const { gpt } = setup([
    { text: JSON.stringify({ verdict: "maybe", extra: 1 }) },
    { text: "not json" },
    { refusal: "no" },
  ]);
  const mismatch = await failure(gpt.structured({ input: "x", schema }));
  assert(mismatch instanceof GptOutputError, "output error");
  assertEquals(
    mismatch.issues.map((issue) => [issue.path, issue.message]),
    [
      [["verdict"], 'expected one of "yes" | "no"'],
      [[], 'unrecognized key: "extra"'],
    ],
  );
  const notJson = await failure(gpt.structured({ input: "x", schema }));
  assertEquals([notJson.kind, notJson.body], ["output", "not json"]);
  const refused = await failure(gpt.structured({ input: "x", schema }));
  assertEquals([refused.kind, refused.message], [
    "refusal",
    "the model refused: no",
  ]);
  const outcome = await gpt.tryStructured({ input: "x", schema });
  assert(!outcome.ok, "the script is exhausted");
});

Deno.test("models.list reads OpenAI and Codex shapes; pick prefers exact then prefix", async () => {
  const { fake, gpt } = setup([]);
  const models = await gpt.models.list();
  assertEquals(models.map((model) => model.id), [
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.5",
  ]);
  assertEquals(await gpt.models.pick(["gpt-7", "gpt-6"]), "gpt-6-astra");
  assertEquals(await gpt.models.pick(["gpt-5.5"]), "gpt-5.5");
  assertEquals(await gpt.models.pick(["claude"]), null);
  assertEquals(
    fake.fetch.calls[0].url,
    "https://llm.int.exe.xyz/openai/v1/models",
  );
  const codex = new GptClient({
    fetch: () =>
      Promise.resolve(
        jsonResponse({
          models: [{ slug: "gpt-6-sol", display_name: "GPT-6-Sol" }],
        }),
      ),
  });
  assertEquals(
    (await codex.models.list()).map((model) => [model.id, model.displayName]),
    [["gpt-6-sol", "GPT-6-Sol"]],
  );
});

Deno.test("models.list retries 5xx and refuses malformed bodies", async () => {
  let calls = 0;
  const flaky = new GptClient({
    runtime: virtualRuntime(),
    fetch: () =>
      Promise.resolve(
        ++calls === 1 ? status(503, {}) : jsonResponse({ data: [{ id: "m" }] }),
      ),
  });
  assertEquals((await flaky.models.list()).length, 1);
  const broken = new GptClient({
    fetch: () => Promise.resolve(jsonResponse({ nope: true })),
  });
  const error = await failure(broken.models.list());
  assertEquals(error.kind, "decode");
});

Deno.test("the pacer is asked before each attempt and told what happened", async () => {
  const runtime = virtualRuntime();
  const pacer = memoryPacer({ now: runtime.now, config: { maxConcurrent: 1 } });
  const { gpt } = setup([
    {
      text: "ok",
      headers: {
        "x-codex-primary-used-percent": "50",
        "x-codex-primary-reset-at": "1760000000",
      },
    },
  ], { pacer, runtime });
  await gpt.respond({ input: "x" });
  const snapshot = pacer.snapshot();
  assertEquals([
    snapshot.inFlight,
    snapshot.totals.calls,
    snapshot.totals.inputTokens,
  ], [0, 1, 100]);
  assertEquals(snapshot.rateLimits[0].primary?.usedPercent, 50);
});

Deno.test("a usage limit holds every caller sharing the pacer until reset", async () => {
  const runtime = virtualRuntime();
  const pacer = memoryPacer({ now: runtime.now });
  const resetsAt = Math.floor(runtime.now() / 1000) + 3600;
  const { fake, gpt } = setup([
    status(429, {
      error: { type: "usage_limit_reached", resets_at: resetsAt },
    }),
    { text: "never sent" },
  ], { pacer, runtime });
  await failure(gpt.respond({ input: "x" }));
  const second = await failure(gpt.respond({ input: "y" }));
  assertEquals([second.kind, second.resetsAt, fake.requests.length], [
    "usage_limit",
    resetsAt * 1000,
    1,
  ]);
  assert(second.message.includes("was not sent"), second.message);
  assertEquals(pacer.snapshot().block?.reason, "usage_limit");
});

Deno.test("a short pacer hold is waited out", async () => {
  const runtime = virtualRuntime();
  const pacer = memoryPacer({ now: runtime.now });
  pacer.block({
    until: runtime.now() + 2000,
    reason: "rate_limited",
    code: null,
  });
  const { gpt } = setup([{ text: "ok" }], { pacer, runtime });
  await gpt.respond({ input: "x" });
  assertEquals(runtime.sleeps, [2000]);
});

Deno.test("a pacer that fails does not stop traffic", async () => {
  const errors: unknown[] = [];
  const pacer = {
    acquire: () => Promise.reject(new Error("object unreachable")),
    release: () => Promise.resolve(),
  };
  const { gpt } = setup([{ text: "ok" }], {
    pacer,
    onPacerError: (error) => errors.push(error),
  });
  assertEquals((await gpt.respond({ input: "x" })).text, "ok");
  assertEquals(errors.length, 1);
});
