// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** The examples in README.md and src/mod.ts, as written there. */

import { assertEquals } from "@celld/core/assert";
import { apiKey, hashApiKey, hashedKeys, router } from "@celld/web/router";
import {
  type Decision,
  durableLimiter,
  memoryLimiter,
  type ShardNamespace,
} from "@celld/sec/ratelimit";
import { byIp, byPrincipal, rateLimit } from "@celld/sec/ratelimit/router";
import { ManualClock, memoryNamespace } from "@celld/sec/ratelimit/testing";

interface Env {
  readonly RATE_LIMITS: ShardNamespace;
  readonly API_KEYS: string;
}

function build(env: Env) {
  // Every address: 120 requests a minute, 20 at once.
  const perAddress = durableLimiter(env.RATE_LIMITS, {
    name: "address",
    policies: [{ name: "address", limit: 120, window: "PT1M", burst: 20 }],
  });
  // Every caller: 10 a second and 1,000 an hour, both at once.
  const perCaller = durableLimiter(env.RATE_LIMITS, {
    name: "caller",
    policies: [
      { name: "second", limit: 10, window: 1 },
      { name: "hour", limit: 1000, window: "PT1H" },
    ],
  });
  const app = router<Env>({
    auth: apiKey({ lookup: hashedKeys(JSON.parse(env.API_KEYS)) }),
  }).use(rateLimit({ limiter: perAddress, key: byIp() }));
  app.get(
    "/reports",
    { use: [rateLimit({ limiter: perCaller, key: byPrincipal(), cost: 5 })] },
    (c) => c.json({ for: c.principal.subject }),
  );
  return app;
}

const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  abort: () => {},
  exports: {},
  props: undefined,
};

Deno.test("the README's quick tour", async () => {
  const env: Env = {
    RATE_LIMITS: memoryNamespace(),
    API_KEYS: JSON.stringify({
      [await hashApiKey("example-key")]: { subject: "alice" },
    }),
  };
  const app = build(env);
  const get = () =>
    app.fetch(
      new Request("https://api.example.com/reports", {
        headers: {
          "x-api-key": "example-key",
          "cf-connecting-ip": "192.0.2.1",
        },
      }),
      env,
      ctx,
    );
  const first = await get();
  assertEquals(first.status, 200);
  assertEquals(
    first.headers.get("ratelimit-policy"),
    '"address";q=120;w=60, "second";q=10;w=1, "hour";q=1000;w=3600',
  );
  assertEquals(
    first.headers.get("ratelimit"),
    '"address";r=19;t=1, "second";r=5;t=1, "hour";r=995;t=18',
  );
  assertEquals((await get()).status, 200);
  const refused = await get();
  assertEquals(refused.status, 429);
  assertEquals(refused.headers.get("retry-after"), "1");
  assertEquals((await refused.json()).error, "rate_limited");
});

Deno.test("the README's failure count: charge first, refund on success", async () => {
  const clock = new ManualClock();
  const failures = durableLimiter(memoryNamespace({ now: clock.now }), {
    name: "login-failures",
    policies: [{ name: "failures", limit: 5, window: "PT15M" }],
    now: clock.now,
  });
  const passwords: Record<string, string> = { alice: "correct horse" };
  async function login(username: string, password: string): Promise<string> {
    const decision: Decision = await failures.limit(`user:${username}`);
    if (!decision.allowed) return `429 after ${decision.retryAfterMs} ms`;
    if (passwords[username] === password) {
      await failures.refund(`user:${username}`);
      return "signed in";
    }
    return "wrong password";
  }
  for (let i = 0; i < 4; i++) {
    assertEquals(await login("alice", "guess"), "wrong password");
  }
  // Successes are refunded, so they never use up the budget.
  for (let i = 0; i < 10; i++) {
    assertEquals(await login("alice", "correct horse"), "signed in");
  }
  assertEquals(await login("alice", "guess"), "wrong password");
  // Five failures: even the right password waits now.
  assertEquals(await login("alice", "correct horse"), "429 after 180000 ms");
  // Parallel guesses are capped by the limit, too.
  const guesses = await Promise.all(
    Array.from({ length: 20 }, () => login("bob", "guess")),
  );
  assertEquals(guesses.filter((g) => g === "wrong password").length, 5);
});

Deno.test("the README's pacing", async () => {
  const clock = new ManualClock();
  const upstream = memoryLimiter({
    policies: [{ name: "rpm", limit: 60, window: "PT1M", burst: 2 }],
    now: clock.now,
  });
  const delays: number[] = [];
  for (let i = 0; i < 4; i++) {
    const decision = await upstream.limit("openai", { maxDelayMs: 10_000 });
    if (!decision.allowed) throw new Error("the upstream is saturated");
    delays.push(decision.delayMs);
  }
  assertEquals(delays, [0, 0, 1000, 2000]);
});

Deno.test("the README's upstream: costs by policy, charges and holds", async () => {
  const clock = new ManualClock();
  const env = { RATE_LIMITS: memoryNamespace({ now: clock.now }) };
  const upstream = durableLimiter(env.RATE_LIMITS, {
    name: "llm",
    policies: [
      { name: "requests", limit: 600, window: "PT1M", burst: 10 },
      { name: "tokens", limit: 20_000, window: 1 },
    ],
    now: clock.now,
  });
  type Answer =
    | { readonly status: 200; readonly usage: { readonly tokens: number } }
    | { readonly status: 429; readonly retryAfterMs: number };
  const answers: Answer[] = [];
  async function call(): Promise<string> {
    const decision = await upstream.limit("account", { cost: { requests: 1 } });
    if (!decision.allowed) return `429 after ${decision.retryAfterMs} ms`;
    const response = answers.shift()!;
    if (response.status === 429) {
      await upstream.hold("account", { forMs: response.retryAfterMs });
      return "held";
    }
    await upstream.charge("account", {
      cost: { tokens: response.usage.tokens },
    });
    return "answered";
  }
  answers.push({ status: 200, usage: { tokens: 30_000 } });
  assertEquals(await call(), "answered");
  // 30,000 tokens against a burst of 20,000: half a second of debt.
  assertEquals(await call(), "429 after 500 ms");
  clock.advance(500);
  answers.push({ status: 429, retryAfterMs: 2000 });
  assertEquals(await call(), "held");
  assertEquals(await call(), "429 after 2000 ms");
  clock.advance(2000);
  answers.push({ status: 200, usage: { tokens: 10 } });
  assertEquals(await call(), "answered");
});
