// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  choice,
  JevAbortError,
  JevApiError,
  JevClient,
  type JevClientOptions,
  JevConnectionError,
  JevDecodeError,
  JevError,
  JevTimeoutError,
  type Limiter,
  noul,
  type RetryEvent,
  type Runtime,
} from "@celld/api/jev";
import { memoryLimiter } from "@celld/api/jev/limiter";
import {
  fakeBody,
  fakeFetch,
  jsonResponse,
  type RecordedRequest,
  virtualRuntime,
} from "@celld/api/jev/testing";

const questions = {
  urgent: noul("Urgent?"),
  team: choice("Team?", ["billing", "technical"]),
};
const request = { state: "Payouts have failed for 3 days.", questions };

function answer(call: RecordedRequest, headers: Record<string, string> = {}) {
  return jsonResponse(fakeBody(call.body.questions), {
    headers: { "x-typesafe-request-id": "req-ok", ...headers },
  });
}

function status(
  code: number,
  headers: Record<string, string> = {},
  body: unknown = {
    detail: `status ${code}`,
  },
): Response {
  return jsonResponse(body, { status: code, headers });
}

/** Answers with each scripted response in turn, then with success. */
function script(...steps: (Response | Error)[]) {
  return fakeFetch((call, index) => {
    const step = steps[index];
    if (step instanceof Error) throw step;
    return step ?? answer(call);
  });
}

function client(
  fetch: JevClientOptions["fetch"],
  options: Partial<JevClientOptions> = {},
) {
  const runtime = virtualRuntime();
  const events: RetryEvent[] = [];
  const jev = new JevClient({
    apiKey: "sk-test",
    fetch,
    runtime,
    onRetry: (event) => events.push(event),
    ...options,
  });
  return { jev, runtime, events };
}

async function failure(promise: Promise<unknown>): Promise<JevError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JevError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

/** A fetch that never answers on its own, like a hung connection. */
function hanging(honourSignal: boolean) {
  return fakeFetch((call) =>
    new Promise<Response>((_, reject) => {
      if (honourSignal) {
        call.signal!.addEventListener(
          "abort",
          () => reject(call.signal!.reason),
        );
      }
    })
  );
}

Deno.test("a successful ask sends the documented request", async () => {
  const fetch = script();
  const { jev } = client(fetch, {
    baseUrl: "https://proxy.example/",
    headers: { "x-team": "support", authorization: "Bearer stolen" },
  });
  const result = await jev.ask(request);
  assertEquals(fetch.calls.length, 1);
  const [call] = fetch.calls;
  assertEquals(call.url, "https://proxy.example/v1/systemone");
  assertEquals(call.method, "POST");
  assertEquals(call.headers.get("authorization"), "Bearer sk-test");
  assertEquals(call.headers.get("content-type"), "application/json");
  assertEquals(call.headers.get("accept"), "application/json");
  assertEquals(call.headers.get("user-agent"), "celld-jev/0.1.0");
  assertEquals(call.headers.get("x-team"), "support");
  assertEquals(call.body, {
    state: request.state,
    model: "jev-latest",
    questions: {
      urgent: { type: "noul", instructions: "Urgent?" },
      team: {
        type: "choice",
        instructions: "Team?",
        criteria: { billing: null, technical: null },
      },
    },
  });
  assertEquals(result.model, "jev-1.13.0");
  assertEquals(result.usage, { input_tokens: 100, output_tokens: 10 });
  assertEquals(result.meta, {
    requestedModel: "jev-latest",
    attempts: 1,
    latencyMs: 0,
    requestId: "req-ok",
    cache: "off",
  });
  assertEquals(result.answers.team.choice, "billing");
});

Deno.test("models resolve from the request, the call, then the client", async () => {
  const fetch = script();
  const { jev } = client(fetch, { model: "jev-preview" });
  await jev.ask(request);
  await jev.ask(request, { model: "jev-1.13.0" });
  await jev.ask({ ...request, model: "jev-1.12.0" });
  assertEquals(fetch.calls.map((call) => call.body.model), [
    "jev-preview",
    "jev-1.13.0",
    "jev-1.12.0",
  ]);
});

Deno.test("429 waits as retry-after asks, then succeeds", async () => {
  const fetch = script(status(429, { "retry-after": "2" }));
  const { jev, runtime, events } = client(fetch);
  const result = await jev.ask(request);
  assertEquals(result.meta.attempts, 2);
  assertEquals(runtime.sleeps, [2000]);
  assertEquals(
    events.map((event) => [event.attempt, event.delayMs, event.error.kind]),
    [
      [1, 2000, "rate_limited"],
    ],
  );
  assertEquals(events[0].error.retryAfterMs, 2000);
});

Deno.test("retry-after as an HTTP date and in milliseconds", async () => {
  const { jev, runtime } = client(
    script(
      status(529, {
        "retry-after": new Date(virtualRuntime().now() + 3000).toUTCString(),
      }),
      status(503, { "retry-after-ms": "120" }),
    ),
  );
  await jev.ask(request);
  assertEquals(runtime.sleeps, [3000, 120]);
});

Deno.test("without retry-after, 529 and 5xx back off exponentially", async () => {
  const { jev, runtime, events } = client(script(status(529), status(503)));
  const result = await jev.ask(request);
  assertEquals(result.meta.attempts, 3);
  // 500 and 1000 ms, less a quarter of each times random() = 0.5.
  assertEquals(runtime.sleeps, [438, 875]);
  assertEquals(events.map((event) => event.error.kind), [
    "overloaded",
    "server",
  ]);
});

Deno.test("retries stop after maxRetries", async () => {
  const fetch = script(status(500), status(500), status(500), status(500));
  const { jev, runtime } = client(fetch);
  const error = await failure(jev.ask(request));
  assert(error instanceof JevApiError, "an API error");
  assertEquals([error.kind, error.status, error.attempts], ["server", 500, 3]);
  assertEquals(error.message, "TypeSafe returned 500 (server): status 500");
  assertEquals(fetch.calls.length, 3);
  assertEquals(runtime.sleeps.length, 2);
});

Deno.test("4xx other than 429 are never retried", async () => {
  for (
    const [code, kind] of [
      [400, "bad_request"],
      [401, "authentication"],
      [403, "permission"],
      [404, "not_found"],
      [408, "http"],
      [409, "http"],
      [422, "validation"],
    ] as const
  ) {
    const fetch = script(status(code));
    const error = await failure(client(fetch).jev.ask(request));
    assertEquals([error.kind, error.status, error.attempts], [kind, code, 1]);
    assertEquals(fetch.calls.length, 1);
  }
});

Deno.test("422 carries the server's located detail", async () => {
  const body = {
    detail: [{
      loc: ["body", "questions", "team", "criteria"],
      msg: "bad option",
    }],
  };
  const error = await failure(
    client(script(status(422, { "x-typesafe-request-id": "req-422" }, body)))
      .jev
      .ask(request),
  );
  assertEquals(error.issues, [
    {
      code: "custom",
      path: ["questions", "team", "criteria"],
      message: "bad option",
    },
  ]);
  assertEquals(error.requestId, "req-422");
  assertEquals(error.body, body);
});

Deno.test("statuses can opt in to more retries", async () => {
  const fetch = script(status(408));
  const { jev } = client(fetch, { retry: { statuses: [408, 429] } });
  assertEquals((await jev.ask(request)).meta.attempts, 2);
  // And per call.
  const again = script(status(500));
  const error = await failure(
    client(again).jev.ask(request, { retry: { maxRetries: 0 } }),
  );
  assertEquals([error.kind, error.attempts], ["server", 1]);
});

Deno.test("retry-after is capped by maxRetryAfterMs and the budget", async () => {
  const slow = () => status(429, { "retry-after": "120" });
  const unbudgeted = client(script(slow()), { retry: { budgetMs: null } });
  await unbudgeted.jev.ask(request);
  assertEquals(unbudgeted.runtime.sleeps, [60000]);
  // With the default 30 s budget the capped wait no longer fits.
  const budgeted = client(script(slow()));
  const error = await failure(budgeted.jev.ask(request));
  assertEquals([error.kind, error.attempts, error.retryAfterMs], [
    "rate_limited",
    1,
    120000,
  ]);
  assertEquals(budgeted.runtime.sleeps, []);
});

Deno.test("the budget stops a retry whose wait would reach it", async () => {
  const { jev, runtime } = client(script(status(500), status(500)), {
    retry: { budgetMs: 1000 },
  });
  const error = await failure(jev.ask(request));
  assertEquals(error.attempts, 2);
  assertEquals(runtime.sleeps, [438]);
});

Deno.test("respectRetryAfter false uses backoff instead", async () => {
  const { jev, runtime } = client(script(status(429, { "retry-after": "9" })), {
    retry: { respectRetryAfter: false, backoffJitter: 0 },
  });
  await jev.ask(request);
  assertEquals(runtime.sleeps, [500]);
});

Deno.test("connection failures are retried unless disabled", async () => {
  const fetch = script(new TypeError("connection reset"));
  const { jev } = client(fetch);
  assertEquals((await jev.ask(request)).meta.attempts, 2);
  const error = await failure(
    client(script(new TypeError("dns")), {
      retry: { retryConnectionErrors: false },
    }).jev.ask(request),
  );
  assert(error instanceof JevConnectionError, "connection error");
  assertEquals(
    error.message,
    "POST https://api.typesafe.ai/v1/systemone failed reading the response: dns",
  );
  assertEquals(error.attempts, 1);
});

Deno.test("a body cut short is a connection failure", async () => {
  const broken = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"model":'));
          controller.error(new Error("reset mid-body"));
        },
      }),
      { status: 200 },
    );
  const fetch = fakeFetch((call, index) =>
    index === 0 ? broken() : answer(call)
  );
  const { jev, events } = client(fetch);
  assertEquals((await jev.ask(request)).meta.attempts, 2);
  assertEquals(events[0].error.kind, "connection");
});

Deno.test("attempts time out, whether or not fetch honours its signal", async () => {
  for (const honour of [true, false]) {
    const fetch = hanging(honour);
    const { jev } = client(fetch, { timeoutMs: 20 });
    const error = await failure(jev.ask(request));
    assert(error instanceof JevTimeoutError, "timeout");
    assertEquals(error.attempts, 3);
    assertEquals(
      error.message,
      "no response from POST https://api.typesafe.ai/v1/systemone within 20 ms",
    );
    assert(fetch.calls.every((call) => call.signal!.aborted), "aborted");
  }
  const once = client(hanging(true), { timeoutMs: 5000 });
  const error = await failure(
    once.jev.ask(request, { timeoutMs: 20, retry: { retryTimeouts: false } }),
  );
  assertEquals([error.kind, error.attempts], ["timeout", 1]);
});

Deno.test("aborting stops the attempt and is never retried", async () => {
  const fetch = hanging(true);
  const { jev } = client(fetch);
  const controller = new AbortController();
  const pending = failure(jev.ask(request, { signal: controller.signal }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const error = await pending;
  assert(error instanceof JevAbortError, "aborted");
  assertEquals([error.attempts, fetch.calls.length], [1, 1]);

  const early = script();
  const before = await failure(
    client(early).jev.ask(request, { signal: AbortSignal.abort() }),
  );
  assertEquals([before.kind, early.calls.length], ["aborted", 0]);
});

Deno.test("aborting stops a retry wait", async () => {
  const controller = new AbortController();
  let waiting: (() => void) | null = null;
  const runtime: Runtime = {
    ...virtualRuntime(),
    sleep(_ms, signal) {
      return new Promise((_, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason));
        waiting?.();
      });
    },
  };
  const fetch = script(status(500));
  const jev = new JevClient({ apiKey: "k", fetch, runtime });
  const slept = new Promise<void>((resolve) => waiting = resolve);
  const pending = failure(jev.ask(request, { signal: controller.signal }));
  await slept;
  controller.abort();
  const error = await pending;
  assertEquals([error.kind, error.attempts, fetch.calls.length], [
    "aborted",
    1,
    1,
  ]);
});

Deno.test("a 2xx that does not answer is a decode error, not retried", async () => {
  const wrong = fakeFetch(() =>
    jsonResponse(
      {
        model: "jev-1.13.0",
        answers: {},
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      { headers: { "x-typesafe-request-id": "req-bad" } },
    )
  );
  const error = await failure(client(wrong).jev.ask(request));
  assert(error instanceof JevDecodeError, "decode");
  assertEquals([error.status, error.requestId, error.attempts], [
    200,
    "req-bad",
    1,
  ]);
  assertEquals(error.issues.map((issue) => issue.path), [
    ["answers", "urgent"],
    ["answers", "team"],
  ]);
  const text = fakeFetch(() =>
    new Response("<html>gateway</html>", { status: 200 })
  );
  const notJson = await failure(client(text).jev.ask(request));
  assertEquals([notJson.kind, notJson.body], [
    "decode",
    "<html>gateway</html>",
  ]);
  assertEquals(text.calls.length, 1);
});

Deno.test("tryAsk returns plain data for either outcome", async () => {
  const good = await client(script()).jev.tryAsk(request);
  assert(good.ok, "ok");
  assertEquals(good.result.answers.urgent.noul, 1);
  const bad = await client(script(status(401))).jev.tryAsk(request);
  assert(!bad.ok, "not ok");
  assertEquals(structuredClone(bad.error), {
    kind: "authentication",
    message: "TypeSafe returned 401 (authentication): status 401",
    status: 401,
    retryAfterMs: null,
    requestId: null,
    body: { detail: "status 401" },
    issues: [],
    attempts: 1,
    retryable: false,
  });
});

Deno.test("models.list goes through the same machinery", async () => {
  const fetch = fakeFetch((_, index) =>
    index === 0 ? status(503) : jsonResponse({
      models: [
        {
          name: "jev-latest",
          description: "Stable",
          release_date: "2026-08-01",
        },
      ],
    })
  );
  const { jev } = client(fetch);
  assertEquals(await jev.models.list(), [
    { name: "jev-latest", description: "Stable", release_date: "2026-08-01" },
  ]);
  assertEquals(fetch.calls.map((call) => [call.method, call.url]), [
    ["GET", "https://api.typesafe.ai/v1/models"],
    ["GET", "https://api.typesafe.ai/v1/models"],
  ]);
  assertEquals(fetch.calls[0].headers.get("content-type"), null);
  assertEquals(fetch.calls[0].body, undefined);
});

Deno.test("fromEnv reads the SDK variable names from bindings", () => {
  const jev = JevClient.fromEnv({
    TYPESAFE_API_KEY: "sk",
    TYPESAFE_BASE_URL: "http://127.0.0.1:9999",
    TYPESAFE_DEFAULT_MODEL: "jev-1.13.0",
  });
  assertEquals([jev.baseUrl, jev.model], [
    "http://127.0.0.1:9999",
    "jev-1.13.0",
  ]);
  const defaults = JevClient.fromEnv({
    TYPESAFE_API_KEY: "sk",
    TYPESAFE_BASE_URL: "",
  });
  assertEquals([defaults.baseUrl, defaults.model], [
    "https://api.typesafe.ai",
    "jev-latest",
  ]);
  let message = "";
  try {
    JevClient.fromEnv({});
  } catch (error) {
    assert(error instanceof TypeError, "a TypeError");
    message = error.message;
  }
  assertEquals(
    message,
    "TYPESAFE_API_KEY is not bound; add it as a secret for this Worker",
  );
});

Deno.test("configuration is checked at construction", () => {
  const messages: string[] = [];
  for (
    const options of [
      { apiKey: "" },
      { apiKey: "k", baseUrl: "ftp://example.com" },
      { apiKey: "k", baseUrl: "not a url" },
      { apiKey: "k", timeoutMs: 0 },
      { apiKey: "k", reserveTokens: -1 },
      { apiKey: "k", retry: { backoffMaxMs: -1 } },
    ]
  ) {
    try {
      new JevClient(options);
    } catch (error) {
      messages.push((error as Error).message);
    }
  }
  assertEquals(messages, [
    "JevClient needs an apiKey",
    "baseUrl must be http(s), got ftp://example.com",
    "baseUrl is not a URL: not a url",
    "timeoutMs must be a positive number, got 0",
    "reserveTokens must be non-negative, got -1",
    "retry.backoffMaxMs must be a finite number from 0, got -1",
  ]);
});

/** A limiter that records calls and answers acquire from a script. */
function recordingLimiter(
  decisions: ({ granted: true } | { granted: false; waitMs: number })[],
) {
  const log: string[] = [];
  const limiter: Limiter = {
    acquire({ reserveTokens }) {
      log.push(`acquire ${reserveTokens}`);
      return decisions.shift() ?? { granted: true };
    },
    settle({ reservedTokens, actualTokens }) {
      log.push(`settle ${reservedTokens} ${actualTokens}`);
    },
    throttle({ retryAfterMs }) {
      log.push(`throttle ${retryAfterMs}`);
    },
  };
  return { limiter, log };
}

Deno.test("the limiter admits each attempt and is charged actual usage", async () => {
  const { limiter, log } = recordingLimiter([{ granted: false, waitMs: 250 }]);
  const fetch = script(
    status(429, { "retry-after": "1" }),
    new TypeError("reset"),
  );
  const { jev, runtime } = client(fetch, { limiter, reserveTokens: 50 });
  await jev.ask(request);
  assertEquals(log, [
    "acquire 50",
    "acquire 50",
    "throttle 1000",
    "settle 50 0",
    "acquire 50",
    "settle 50 0",
    "acquire 50",
    "settle 50 100",
  ]);
  // The third wait is the second retry's backoff: 1000 ms less jitter.
  assertEquals(runtime.sleeps, [250, 1000, 875]);
});

Deno.test("a limiter that cannot admit in budget fails without calling", async () => {
  const fetch = script();
  const { limiter } = recordingLimiter(
    Array.from(
      { length: 100 },
      () => ({ granted: false as const, waitMs: 20_000 }),
    ),
  );
  const error = await failure(client(fetch, { limiter }).jev.ask(request));
  assert(error instanceof JevTimeoutError, "timeout");
  assertEquals(
    error.message,
    "the rate limiter could not admit the request within the 30000 ms budget",
  );
  assertEquals(fetch.calls.length, 0);
});

Deno.test("a failing limiter lets traffic through and reports it", async () => {
  const seen: unknown[] = [];
  const limiter: Limiter = {
    acquire() {
      throw new Error("limiter unreachable");
    },
    settle() {},
  };
  const { jev } = client(script(), {
    limiter,
    onLimiterError: (error) => seen.push((error as Error).message),
  });
  assertEquals((await jev.ask(request)).meta.attempts, 1);
  assertEquals(seen, ["limiter unreachable"]);
});

Deno.test("the in-memory limiter paces a burst", async () => {
  const runtime = virtualRuntime();
  const limiter = memoryLimiter({
    limits: { requestsPerMinute: 60, requestBurst: 2 },
    now: runtime.now,
  });
  const fetch = script();
  const jev = new JevClient({ apiKey: "k", fetch, runtime, limiter });
  for (let i = 0; i < 4; i++) await jev.ask(request);
  // Two at once, then one a second.
  assertEquals(runtime.sleeps, [1000, 1000]);
  // A second of refill covers each request's 100 tokens.
  assertEquals(limiter.snapshot().tokens, 249_900);
});
