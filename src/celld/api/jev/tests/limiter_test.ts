// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { JevRateLimiter } from "@celld/api/jev/durable";
import {
  DEFAULT_RATE_LIMITS,
  durableLimiter,
  type RateLimiterApi,
  resolveRateLimits,
  TokenBucket,
} from "@celld/api/jev/limiter";

const limits = resolveRateLimits({
  requestsPerMinute: 120,
  requestBurst: 2,
  tokensPerSecond: 1000,
  tokenBurst: 1000,
});

Deno.test("defaults are Jev 1.13's documented limits", () => {
  assertEquals(DEFAULT_RATE_LIMITS, {
    requestsPerMinute: 1200,
    requestBurst: 20,
    tokensPerSecond: 250_000,
    tokenBurst: 250_000,
  });
  let message = "";
  try {
    resolveRateLimits({ tokensPerSecond: 0 });
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message, "tokensPerSecond must be a positive number, got 0");
});

Deno.test("requests: a burst, then the average rate", () => {
  const bucket = new TokenBucket(limits, 0);
  assertEquals(bucket.acquire(0, 0), { granted: true });
  assertEquals(bucket.acquire(0, 0), { granted: true });
  // 120 a minute is one every 500 ms.
  assertEquals(bucket.acquire(0, 0), { granted: false, waitMs: 500 });
  assertEquals(bucket.acquire(250, 0), { granted: false, waitMs: 250 });
  assertEquals(bucket.acquire(500, 0), { granted: true });
});

Deno.test("tokens: usage is charged after the fact and debt blocks", () => {
  const bucket = new TokenBucket(limits, 0);
  assertEquals(bucket.acquire(0, 0), { granted: true });
  bucket.settle(0, 0, 1500);
  assertEquals(bucket.snapshot(0).tokens, -500);
  // Half a second to pay off 500 tokens at 1000 a second.
  assertEquals(bucket.acquire(0, 0), { granted: false, waitMs: 500 });
  assertEquals(bucket.acquire(500, 0), { granted: true });
});

Deno.test("tokens: reservations wait for room and settle the difference", () => {
  const bucket = new TokenBucket(limits, 0);
  assertEquals(bucket.acquire(0, 800), { granted: true });
  assertEquals(bucket.acquire(0, 800), { granted: false, waitMs: 600 });
  bucket.settle(0, 800, 300);
  assertEquals(bucket.snapshot(0).tokens, 700);
  // A reservation over the burst is capped at it instead of waiting forever.
  const fresh = new TokenBucket(limits, 0);
  assertEquals(fresh.acquire(0, 5000), { granted: true });
});

Deno.test("throttle holds every caller until the server's retry-after", () => {
  const bucket = new TokenBucket(limits, 0);
  bucket.throttle(0, 2000);
  bucket.throttle(0, 1000);
  assertEquals(bucket.acquire(100, 0), { granted: false, waitMs: 1900 });
  assertEquals(bucket.acquire(2000, 0), { granted: true });
});

Deno.test("configure keeps levels within the new bursts", () => {
  const bucket = new TokenBucket(DEFAULT_RATE_LIMITS, 0);
  bucket.configure(0, limits);
  const snapshot = bucket.snapshot(0);
  assertEquals([snapshot.requests, snapshot.tokens], [2, 1000]);
  assertEquals(snapshot.limits, limits);
});

Deno.test("bad amounts are refused", () => {
  const bucket = new TokenBucket(limits, 0);
  let message = "";
  try {
    bucket.acquire(0, Number.NaN);
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message, "reserveTokens must be a non-negative number, got NaN");
});

Deno.test("durableLimiter forwards to the named object", async () => {
  const names: string[] = [];
  const calls: unknown[] = [];
  const stub = {
    acquire: (request: unknown) => {
      calls.push(["acquire", request]);
      return Promise.resolve({ granted: true });
    },
    settle: (charge: unknown) => {
      calls.push(["settle", charge]);
      return Promise.resolve();
    },
    throttle: (request: unknown) => {
      calls.push(["throttle", request]);
      return Promise.resolve();
    },
  };
  const namespace = {
    getByName(name: string) {
      names.push(name);
      return stub;
    },
  } as unknown as DurableObjectNamespace<RateLimiterApi>;
  const limiter = durableLimiter(namespace, "account-7");
  assertEquals(await limiter.acquire({ reserveTokens: 3 }), { granted: true });
  await limiter.settle({ reservedTokens: 3, actualTokens: 9 });
  await limiter.throttle!({ retryAfterMs: 10 });
  assertEquals(names, ["account-7", "account-7", "account-7"]);
  assertEquals(calls, [
    ["acquire", { reserveTokens: 3 }],
    ["settle", { reservedTokens: 3, actualTokens: 9 }],
    ["throttle", { retryAfterMs: 10 }],
  ]);
});

Deno.test("the Durable Object class loads under the fake runtime", () => {
  // The real object runs in tests/runtime_test.py; here only its shape.
  const methods = Object.getOwnPropertyNames(JevRateLimiter.prototype);
  for (
    const name of ["acquire", "settle", "throttle", "configure", "snapshot"]
  ) {
    assert(methods.includes(name), name);
  }
});
