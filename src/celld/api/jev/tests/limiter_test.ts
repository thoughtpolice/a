// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "@celld/core/assert";
import {
  DEFAULT_RATE_LIMITS,
  JevClient,
  jevPolicies,
  noul,
  type RateLimits,
} from "@celld/api/jev";
import {
  fakeBody,
  fakeFetch,
  jsonResponse,
  virtualRuntime,
} from "@celld/api/jev/testing";
import { memoryLimiter } from "@celld/sec/ratelimit";

const request = {
  state: "The export is broken.",
  questions: { urgent: noul("Urgent?") },
};

Deno.test("the defaults are Jev 1.13's documented limits", () => {
  assertEquals(DEFAULT_RATE_LIMITS, {
    requestsPerMinute: 1200,
    requestBurst: 20,
    tokensPerSecond: 250_000,
    tokenBurst: 250_000,
  });
  assertEquals(jevPolicies(), [
    { name: "requests", limit: 1200, window: "PT1M", burst: 20 },
    { name: "tokens", limit: 250_000, window: 1, burst: 250_000 },
  ]);
  assertEquals(jevPolicies({ requestsPerMinute: 60 })[0].limit, 60);
});

Deno.test("bad limits are refused by name", () => {
  assertThrows(
    () => jevPolicies({ tokensPerSecond: 0 }),
    RangeError,
    "tokensPerSecond must be a whole number from 1, got 0",
  );
  assertThrows(
    () => jevPolicies({ requestBurst: 1.5 }),
    RangeError,
    "requestBurst",
  );
  assertThrows(
    () => jevPolicies({ tokensPerSecond: 2_000_000 }),
    RangeError,
    "million",
  );
  assertThrows(() => jevPolicies({ rpm: 5 } as never), TypeError, '"rpm"');
});

/**
 * Clients sharing one in-memory limiter with Jev's policies, on a virtual
 * clock; each answer reports `inputTokens`, or the scripted response.
 */
function fleet(
  limits: Partial<RateLimits>,
  options: {
    readonly inputTokens?: number;
    readonly reserveTokens?: number;
    readonly script?: Response[];
  } = {},
) {
  const runtime = virtualRuntime();
  const limiter = memoryLimiter({
    policies: jevPolicies(limits),
    now: runtime.now,
  });
  const script = [...(options.script ?? [])];
  const fetch = fakeFetch((call) =>
    script.shift() ??
      jsonResponse(fakeBody(call.body.questions, {
        usage: { input_tokens: options.inputTokens ?? 100, output_tokens: 1 },
      }))
  );
  const errors: unknown[] = [];
  const client = (idempotentAsks = true) =>
    new JevClient({
      apiKey: "k",
      fetch,
      runtime,
      limiter,
      reserveTokens: options.reserveTokens,
      idempotentAsks,
      onLimiterError: (error) => errors.push(error),
    });
  return { runtime, limiter, fetch, client, errors };
}

Deno.test("requests: a burst, then the average rate", async () => {
  const { runtime, client } = fleet({
    requestsPerMinute: 120,
    requestBurst: 2,
  });
  const jev = client();
  for (let i = 0; i < 4; i++) await jev.ask(request);
  // 120 a minute is one every 500 ms.
  assertEquals(runtime.sleeps, [500, 500]);
});

Deno.test("tokens: usage is charged afterwards, and the debt holds the next ask", async () => {
  const { runtime, limiter, client } = fleet(
    { tokensPerSecond: 1000, tokenBurst: 1000 },
    { inputTokens: 1500 },
  );
  const jev = client();
  await jev.ask(request);
  // 1,500 tokens against a burst of 1,000: half a second to pay off.
  const inDebt = await limiter.peek("default", { cost: 0 });
  assertEquals([inDebt.allowed, inDebt.retryAfterMs], [false, 500]);
  await jev.ask(request);
  assertEquals(runtime.sleeps, [500]);
});

Deno.test("tokens: a reservation is taken up front and the rest refunded", async () => {
  const { limiter, client } = fleet(
    { tokensPerSecond: 1000, tokenBurst: 1000 },
    { inputTokens: 300, reserveTokens: 800 },
  );
  await client().ask(request);
  const after = await limiter.peek("default", { cost: 0 });
  assertEquals(after.policies[1].remaining, 700);
  // A reservation over the burst is capped at it instead of never fitting.
  const large = fleet({ tokenBurst: 1000 }, { reserveTokens: 5000 });
  await large.client().ask(request);
  assertEquals(large.errors, []);
});

Deno.test("a 429's retry-after holds every caller sharing the limiter", async () => {
  const { runtime, fetch, client, errors } = fleet({}, {
    script: [jsonResponse({ detail: "slow down" }, {
      status: 429,
      headers: { "retry-after": "2" },
    })],
  });
  // An ask not declared idempotent is not sent again...
  assertEquals((await client(false).tryAsk(request)).ok, false);
  // ...but the retry-after holds the key, so the next caller waits it out.
  await client().ask(request);
  assertEquals(runtime.sleeps, [2000]);
  assertEquals([fetch.calls.length, errors], [2, []]);
});
