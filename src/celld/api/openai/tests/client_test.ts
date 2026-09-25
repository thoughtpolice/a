// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import {
  DEFAULT_RETRY_POLICY,
  GptClient,
  type GptClientOptions,
  GptConnectionError,
  GptError,
  GptOutputError,
  GptStreamError,
  GptTimeoutError,
  integrationBaseUrl,
  mayRetryGpt,
  memoryPacer,
  requestIdempotency,
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
  // `scheme: "http"` was an ad-hoc cleartext override (DB-SWP-F16-13.6);
  // the domain override stays.
  assertEquals(
    integrationBaseUrl("llm", { domain: "int.test" }),
    "https://llm.int.test/openai/v1",
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
    OPENAI_LOOPBACK_FOR_DEVELOPMENT: "true",
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

Deno.test("every request kind declares whether it may be sent twice", () => {
  // Responses calls are side-effect free only because the body says
  // `store: false`; anything that keeps state on the server is not.
  assertEquals(requestIdempotency("responses", { store: false }), true);
  assertEquals(requestIdempotency("responses", { store: true }), false);
  assertEquals(requestIdempotency("responses", {}), false);
  assertEquals(requestIdempotency("models.list"), true);
  let refused = "";
  try {
    requestIdempotency("conversations.create" as "responses", {});
  } catch (error) {
    refused = (error as Error).message;
  }
  assert(refused.includes("conversations.create"), refused);
});

Deno.test("a request the server may keep is never retried after it may have acted", () => {
  const failures = [
    new GptConnectionError("reset"),
    new GptStreamError("broke off", { status: 200 }),
    new GptTimeoutError("slow"),
    new GptError("server", "500", { status: 500 }),
    new GptError("overloaded", "503", { status: 503 }),
    new GptError("rate_limited", "429", { status: 429 }),
  ];
  for (const failure of failures) {
    assertEquals(
      mayRetryGpt(DEFAULT_RETRY_POLICY, failure, { idempotent: true }),
      true,
      `${failure.kind} of an idempotent request`,
    );
    assertEquals(
      mayRetryGpt(DEFAULT_RETRY_POLICY, failure, { idempotent: false }),
      false,
      `${failure.kind} of a request that is not idempotent`,
    );
  }
  // Only the kinds in retryOn, and never an abort.
  assertEquals(
    mayRetryGpt(
      { ...DEFAULT_RETRY_POLICY, retryOn: ["server"] },
      new GptStreamError("broke off"),
      { idempotent: true },
    ),
    false,
  );
  assertEquals(
    mayRetryGpt(
      {
        ...DEFAULT_RETRY_POLICY,
        retryOn: [...DEFAULT_RETRY_POLICY.retryOn, "aborted"],
      },
      new GptError("aborted", "stop"),
      { idempotent: true },
    ),
    false,
  );
  let undeclared = "";
  try {
    mayRetryGpt(
      DEFAULT_RETRY_POLICY,
      new GptStreamError("x"),
      {} as { idempotent: boolean },
    );
  } catch (error) {
    undeclared = (error as Error).message;
  }
  assert(undeclared.includes("idempotent"), undeclared);
});

Deno.test("responses are retried because every attempt is sent with store: false", async () => {
  const { fake, gpt, retries } = setup([
    { text: "partial", cutAfter: 5 },
    status(500, { error: { message: "oops" } }),
    { text: "whole" },
  ]);
  const turn = await gpt.respond({ input: "x" });
  assertEquals([turn.text, turn.meta.attempts], ["whole", 3]);
  assertEquals(retries.map((event) => event.error.kind), ["stream", "server"]);
  assertEquals(fake.requests.map((request) => request.body?.store), [
    false,
    false,
    false,
  ]);
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
  let resets = 0;
  const reset = new GptClient({
    runtime: virtualRuntime(),
    fetch: () =>
      ++resets === 1
        ? Promise.reject(new TypeError("connection reset"))
        : Promise.resolve(jsonResponse({ data: [{ id: "m" }] })),
  });
  assertEquals((await reset.models.list()).length, 1);
  assertEquals(resets, 2);
  const broken = new GptClient({
    fetch: () => Promise.resolve(jsonResponse({ nope: true })),
  });
  const error = await failure(broken.models.list());
  assertEquals(error.kind, "decode");
});

// F15 of the 2026-09-26 review: the model listing had its own retry loop,
// which honoured the retry count but never the total budget.
Deno.test("models.list stays within the retry budget and the call's timeouts", async () => {
  let requests = 0;
  const runtime = virtualRuntime();
  const gpt = new GptClient({
    runtime,
    fetch: () => {
      requests++;
      return Promise.resolve(
        requests === 1
          ? status(503, { error: { message: "retry later" } }, {
            "retry-after": "10",
          })
          : jsonResponse({ data: [{ id: "test" }] }),
      );
    },
  });
  const started = runtime.now();
  const error = await failure(gpt.models.list({ retry: { budgetMs: 1 } }));
  assertEquals([error.kind, error.attempts, requests], ["server", 1, 1]);
  assertEquals(runtime.now() - started, 0);
  // Within a budget that has room, the wait is taken and the retry sent.
  assertEquals(
    (await gpt.models.list({ retry: { budgetMs: 60_000 } })).length,
    1,
  );
  // An attempt gets what is left of the budget, and a per-call
  // connectTimeoutMs, whichever is shorter.
  for (
    const [options, message] of [
      [{ retry: { budgetMs: 40, maxRetries: 0 } }, "within 40 ms"],
      [{ connectTimeoutMs: 30, retry: { maxRetries: 0 } }, "within 30 ms"],
    ] as const
  ) {
    const hung = new GptClient({
      runtime: virtualRuntime(),
      fetch: (_url, init) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
          )
        ),
    });
    const timeout = await failure(hung.models.list(options));
    assertEquals(timeout.kind, "timeout");
    assert(timeout.message.includes(message), timeout.message);
  }
});

Deno.test("a response attempt ends when the retry budget does", async () => {
  const gpt = new GptClient({
    runtime: virtualRuntime(),
    fetch: (_url, init) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal!.reason),
        )
      ),
  });
  const error = await failure(
    gpt.respond({ input: "x" }, { retry: { budgetMs: 40, maxRetries: 0 } }),
  );
  assertEquals(error.kind, "timeout");
  assert(
    error.message.includes("40 ms retry budget ran out"),
    error.message,
  );
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

// F05 of the 2026-09-26 review: a call cancelled while the pacer held it
// was sent (and billed) anyway once the pacer admitted it.
Deno.test("cancelling while the pacer holds a call sends nothing and releases the lease", async () => {
  for (const answers of [true, false]) {
    const grant = Promise.withResolvers<{ granted: true; lease: string }>();
    const entered = Promise.withResolvers<void>();
    const released: string[] = [];
    const pacer = {
      acquire: () => {
        entered.resolve();
        return grant.promise;
      },
      release: (report: { lease: string; error?: { kind: string } | null }) => {
        released.push(`${report.lease} ${report.error?.kind ?? "ok"}`);
      },
    };
    const { fake, gpt } = setup([{ text: "ran despite cancellation" }], {
      pacer,
    });
    const abort = new AbortController();
    const pending = failure(
      gpt.respond({ input: "x" }, { signal: abort.signal }),
    );
    await entered.promise;
    abort.abort();
    // Answering late changes nothing; never answering does not hang it.
    if (answers) grant.resolve({ granted: true, lease: "late" });
    const error = await pending;
    // A late lease is released when it arrives.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals([answers, error.kind, error.attempts, fake.requests.length], [
      answers,
      "aborted",
      0,
      0,
    ]);
    assertEquals(released, answers ? ["late aborted"] : []);
  }
});

// ----- Final round (WP-16 follow-up): WP-12's F1-301 and F2-301 -----

const bytes = new TextEncoder();

/** A body that yields `chunk` forever and counts what was pulled. */
function endless(chunk: string, pulled: { bytes: number; cancelled: boolean }) {
  const encoded = bytes.encode(chunk);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled.bytes += encoded.byteLength;
      controller.enqueue(encoded);
    },
    cancel() {
      pulled.cancelled = true;
    },
  });
}

// DB-SWP-F1-301: an error body, a non-streamed JSON answer and the model
// list were read with `response.text()`, which holds whatever the server
// sends. Every body now stops at a byte cap and is cancelled there.
Deno.test("DB-SWP-F1-301: an endless error body is read only up to a cap", async () => {
  const pulled = { bytes: 0, cancelled: false };
  const fetch = () =>
    Promise.resolve(
      new Response(endless("x".repeat(4096), pulled), { status: 500 }),
    );
  const gpt = new GptClient({
    fetch,
    runtime: virtualRuntime(),
    retry: { maxRetries: 0 },
  });
  const error = await failure(gpt.respond({ input: "x" }));
  assertEquals(error.kind, "server");
  assert(pulled.bytes <= 128 * 1024, `pulled ${pulled.bytes} bytes`);
  assert(pulled.cancelled, "the body was cancelled");
  assert(
    typeof error.body === "string" && error.body.length <= 4097,
    "the kept body is still cut",
  );
});

Deno.test("DB-SWP-F1-301: a JSON answer or model list past the cap is refused", async () => {
  const pulled = { bytes: 0, cancelled: false };
  const json = () =>
    Promise.resolve(
      new Response(endless('{"a":"' + "x".repeat(4090), pulled), {
        headers: { "content-type": "application/json" },
      }),
    );
  const gpt = new GptClient({
    fetch: json,
    runtime: virtualRuntime(),
    retry: { maxRetries: 0 },
    maxResponseBytes: 64 * 1024,
  });
  const error = await failure(gpt.respond({ input: "x" }));
  assertEquals(error.kind, "decode");
  assert(error.message.includes("65536 bytes"), error.message);
  assert(pulled.bytes <= 80 * 1024, `pulled ${pulled.bytes} bytes`);
  assert(pulled.cancelled, "the body was cancelled");
  pulled.bytes = 0;
  const models = await failure(gpt.models.list());
  assertEquals(models.kind, "decode");
  assert(pulled.bytes <= 80 * 1024, `models pulled ${pulled.bytes} bytes`);
  for (const maxResponseBytes of [NaN, 0, -1, 2 ** 60]) {
    let refused = false;
    try {
      new GptClient({ maxResponseBytes });
    } catch (caught) {
      refused = caught instanceof RangeError;
    }
    assert(refused, String(maxResponseBytes));
  }
});

// DB-SWP-F1-301 (SSE): the stream had only an idle timer, re-armed by every
// chunk, and no total. Keep-alives or endless events held the call and
// grew the parser and the accumulator without end. A stream now stops at
// `maxResponseBytes` and at `maxStreamMs`.
Deno.test("DB-SWP-F1-301: an endless event stream stops at the byte cap", async () => {
  const pulled = { bytes: 0, cancelled: false };
  let index = 0;
  const events = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Endless new output items: each one a slot in the accumulator.
      const chunk = bytes.encode(`data: ${
        JSON.stringify({
          type: "response.output_item.added",
          output_index: index,
          item: { type: "message", id: `m${index++}`, role: "assistant" },
        })
      }\n\n`);
      pulled.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      pulled.cancelled = true;
    },
  });
  const gpt = new GptClient({
    fetch: () =>
      Promise.resolve(
        new Response(events, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    runtime: virtualRuntime(),
    retry: { maxRetries: 0 },
    maxResponseBytes: 256 * 1024,
  });
  const error = await failure(gpt.respond({ input: "x" }));
  assertEquals(error.kind, "decode");
  assert(error.message.includes("262144 bytes"), error.message);
  assert(pulled.bytes <= 300 * 1024, `pulled ${pulled.bytes} bytes`);
  assert(pulled.cancelled, "the stream was cancelled");
});

Deno.test("DB-SWP-F1-301: a stream kept alive past maxStreamMs times out", async () => {
  let timer = 0;
  const alive = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => controller.enqueue(bytes.encode(":\n\n")), 10);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  const gpt = new GptClient({
    fetch: () =>
      Promise.resolve(
        new Response(alive, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    runtime: virtualRuntime(),
    retry: { maxRetries: 0 },
    idleTimeoutMs: 1000,
    maxStreamMs: 150,
  });
  const started = Date.now();
  const error = await failure(gpt.respond({ input: "x" }));
  clearInterval(timer);
  assertEquals(error.kind, "timeout");
  assert(error.message.includes("150 ms"), error.message);
  assert(Date.now() - started < 900, "stopped by the total, not the idle");
  for (const maxStreamMs of [NaN, 0, 2 ** 31]) {
    let refused = false;
    try {
      new GptClient({ maxStreamMs });
    } catch (caught) {
      refused = caught instanceof RangeError;
    }
    assert(refused, String(maxStreamMs));
  }
});

// DB-SWP-F2-301: `fetch` followed redirects by default, so an API root (or
// a proxy in front of it) could send the request, prompt and all, to
// another origin. Redirects are now never followed: a 3xx is a failure.
Deno.test("DB-SWP-F2-301: redirects are refused, never followed", async () => {
  const seen: (RequestRedirect | undefined)[] = [];
  const fetch = (_input: string | URL | Request, init?: RequestInit) => {
    seen.push(init?.redirect);
    return Promise.resolve(
      new Response("moved", {
        status: 307,
        headers: { location: "https://elsewhere.example/v1/responses" },
      }),
    );
  };
  const gpt = new GptClient({ fetch, runtime: virtualRuntime() });
  const error = await failure(gpt.respond({ input: "x" }));
  assertEquals([error.kind, error.status, error.retryable], [
    "http",
    307,
    false,
  ]);
  assert(error.message.includes("redirect"), error.message);
  const models = await failure(gpt.models.list());
  assertEquals([models.kind, models.status], ["http", 307]);
  assertEquals(seen, ["manual", "manual"]);
});
