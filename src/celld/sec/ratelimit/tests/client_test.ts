// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@celld/core/assert";
import {
  durableLimiter,
  RateLimitUnavailable,
  storageKey,
} from "@celld/sec/ratelimit";
import { ManualClock, memoryNamespace } from "@celld/sec/ratelimit/testing";

function setup(options: { denyCache?: boolean; shards?: number } = {}) {
  const clock = new ManualClock();
  const namespace = memoryNamespace({ now: clock.now });
  const limiter = durableLimiter(namespace, {
    name: "login",
    policies: [{ name: "failures", limit: 3, window: "PT15M" }],
    now: clock.now,
    ...options,
  });
  return { clock, namespace, limiter };
}

Deno.test("durable: decisions come from the key's shard, under a hashed key", async () => {
  const { namespace, limiter } = setup();
  for (let i = 0; i < 3; i++) {
    assertEquals((await limiter.limit("user:alice")).allowed, true);
  }
  const refused = await limiter.limit("user:alice");
  assertEquals(refused.allowed, false);
  assertEquals(refused.retryAfterMs, 300_000);
  const hash = await storageKey("login", "user:alice");
  assertEquals(namespace.calls.map((call) => call.key), [
    hash,
    hash,
    hash,
    hash,
  ]);
  assert(
    namespace.calls.every((call) =>
      /^celld-ratelimit:login:\d+$/.test(call.shard)
    ),
    "shards are named by limiter and number",
  );
  assert(
    !JSON.stringify(namespace.calls).includes("alice"),
    "the key as written never reaches the shard",
  );
});

Deno.test("durable: keys spread over the shards", async () => {
  const { namespace, limiter } = setup({ shards: 4 });
  for (let i = 0; i < 64; i++) await limiter.limit(`user:${i}`);
  assertEquals(namespace.shards.size, 4);
});

Deno.test("durable: a refusal is remembered until a unit is back", async () => {
  const { clock, namespace, limiter } = setup();
  await limiter.limit("user:bob", { cost: 3 });
  const refused = await limiter.limit("user:bob");
  assertEquals(namespace.calls.length, 2);
  // No call until then, and the answer ages with the clock.
  clock.advance(100_000);
  const cached = await limiter.limit("user:bob");
  assertEquals(namespace.calls.length, 2);
  assertEquals(cached.allowed, false);
  assertEquals(cached.retryAfterMs, refused.retryAfterMs - 100_000);
  assertEquals(
    cached.policies[0].resetMs,
    refused.policies[0].resetMs - 100_000,
  );
  // A different cost is still refused, told when a unit is back.
  assertEquals(
    (await limiter.limit("user:bob", { cost: 2 })).retryAfterMs,
    200_000,
  );
  assertEquals(namespace.calls.length, 2);
  clock.advance(200_000);
  assertEquals((await limiter.limit("user:bob")).allowed, true);
  assertEquals(namespace.calls.length, 3);
});

Deno.test("durable: questions, refunds and resets always reach the shard", async () => {
  const { namespace, limiter } = setup();
  await limiter.limit("user:carol", { cost: 3 });
  await limiter.limit("user:carol");
  assertEquals((await limiter.peek("user:carol", { cost: 0 })).remaining, 0);
  await limiter.refund("user:carol");
  assertEquals((await limiter.limit("user:carol")).allowed, true);
  await limiter.reset("user:carol");
  assertEquals((await limiter.peek("user:carol", { cost: 3 })).allowed, true);
  assertEquals(
    namespace.calls.map((call) => call.method),
    ["limit", "limit", "peek", "refund", "limit", "reset", "peek"],
  );
});

Deno.test("durable: charges and holds reach the key's shard", async () => {
  const { clock, namespace, limiter } = setup();
  // Five failures against a burst of three: three intervals of 5 minutes.
  await limiter.charge("user:erin", { cost: 5 });
  assertEquals((await limiter.limit("user:erin")).retryAfterMs, 900_000);
  await limiter.reset("user:erin");
  await limiter.hold("user:erin", { forMs: 60_000 });
  const held = await limiter.limit("user:erin");
  assertEquals([held.allowed, held.retryAfterMs], [false, 60_000]);
  clock.advance(60_000);
  assertEquals((await limiter.limit("user:erin")).allowed, true);
  assertEquals(
    namespace.calls.map((call) => [call.method, call.cost ?? call.forMs]),
    [
      ["charge", 5],
      ["limit", 1],
      ["reset", undefined],
      ["hold", 60_000],
      ["limit", 1],
      ["limit", 1],
    ],
  );
});

Deno.test("durable: only a request that spends from every policy uses the refusal cache", async () => {
  const clock = new ManualClock();
  const namespace = memoryNamespace({ now: clock.now });
  const limiter = durableLimiter(namespace, {
    name: "upstream",
    policies: [
      { name: "requests", limit: 2, window: 1 },
      { name: "tokens", limit: 100, window: 1 },
    ],
    now: clock.now,
  });
  const cost = { requests: 1, tokens: 1 };
  await limiter.limit("svc", { cost: { requests: 2, tokens: 1 } });
  assertEquals((await limiter.limit("svc", { cost })).allowed, false);
  assertEquals((await limiter.limit("svc", { cost })).allowed, false);
  assertEquals(namespace.calls.length, 2);
  // Spending no requests may still be admitted, so it asks the shard.
  assertEquals(
    (await limiter.limit("svc", { cost: { tokens: 5 } })).allowed,
    true,
  );
  assertEquals(namespace.calls.length, 3);
});

Deno.test("durable: a request that may wait is refused from memory only while it would wait longer", async () => {
  const clock = new ManualClock();
  const namespace = memoryNamespace({ now: clock.now });
  const limiter = durableLimiter(namespace, {
    name: "pace",
    policies: [{ name: "rpm", limit: 60, window: "PT1M", burst: 2 }],
    now: clock.now,
  });
  await limiter.limit("svc", { cost: 2 });
  assertEquals((await limiter.limit("svc")).retryAfterMs, 1000);
  assertEquals(namespace.calls.length, 2);
  // Willing to wait five seconds: the shard admits it, due in a second.
  assertEquals(
    (await limiter.limit("svc", { maxDelayMs: 5000 })).delayMs,
    1000,
  );
  assertEquals(namespace.calls.length, 3);
  // Willing to wait half a second: refused from memory.
  assertEquals(
    (await limiter.limit("svc", { maxDelayMs: 500 })).allowed,
    false,
  );
  assertEquals(namespace.calls.length, 3);
});

Deno.test("durable: a request that may wait out a hold is admitted to start when it ends", async () => {
  const { limiter } = setup();
  await limiter.hold("user:fay", { forMs: 30_000 });
  assertEquals((await limiter.limit("user:fay")).retryAfterMs, 30_000);
  const paced = await limiter.limit("user:fay", { maxDelayMs: 60_000 });
  assertEquals([paced.allowed, paced.delayMs], [true, 30_000]);
});

Deno.test("durable: the cache can be turned off", async () => {
  const { namespace, limiter } = setup({ denyCache: false });
  await limiter.limit("k", { cost: 3 });
  await limiter.limit("k");
  await limiter.limit("k");
  assertEquals(namespace.calls.length, 3);
});

Deno.test("durable: an unreachable shard is RateLimitUnavailable", async () => {
  const { namespace, limiter } = setup();
  const cause = new Error("owner_unreachable");
  namespace.failWith = cause;
  const error = await assertRejects(
    () => limiter.limit("user:dave"),
    RateLimitUnavailable,
    "could not reach its shard",
  );
  assert(error.cause === cause, "the cause is kept");
  await assertRejects(() => limiter.reset("user:dave"), RateLimitUnavailable);
  namespace.failWith = null;
  assertEquals((await limiter.limit("user:dave")).allowed, true);
});

Deno.test("durable: a secret changes every stored key", async () => {
  const clock = new ManualClock();
  const namespace = memoryNamespace({ now: clock.now });
  const keyed = durableLimiter(namespace, {
    name: "login",
    policies: [{ name: "failures", limit: 3, window: "PT15M" }],
    secret: "k".repeat(32),
  });
  await keyed.limit("user:alice");
  assert(
    namespace.calls[0].key !== await storageKey("login", "user:alice"),
    "the keyed hash differs",
  );
  const short = durableLimiter(namespace, {
    name: "login",
    policies: [{ name: "failures", limit: 3, window: "PT15M" }],
    secret: "short",
  });
  await assertRejects(() => short.limit("user:alice"), RangeError, "32 bytes");
});

Deno.test("durable: options and arguments are checked before any call", async () => {
  const namespace = memoryNamespace();
  const policies = [{ name: "a", limit: 2, window: 1 }];
  assertThrows(
    () => durableLimiter(namespace, { name: "bad name", policies }),
    TypeError,
  );
  assertThrows(
    () => durableLimiter(namespace, { name: "x", policies, shards: 0 }),
    RangeError,
  );
  assertThrows(
    () => durableLimiter(namespace, { name: "x", policies, extra: 1 } as never),
    TypeError,
    '"extra"',
  );
  assertThrows(
    () => durableLimiter({} as never, { name: "x", policies }),
    TypeError,
    "namespace",
  );
  const limiter = durableLimiter(namespace, { name: "x", policies });
  await assertRejects(() => limiter.limit("k", { cost: 3 }), RangeError);
  await assertRejects(() => limiter.limit(""), TypeError);
  await assertRejects(
    () => limiter.charge("k", { cost: { b: 1 } }),
    TypeError,
  );
  await assertRejects(() => limiter.hold("k", { forMs: -1 }), RangeError);
  assertEquals(namespace.calls, []);
});
