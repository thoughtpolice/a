// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects, assertThrows } from "@celld/core/assert";
import { LocalLimiter, memoryLimiter } from "@celld/sec/ratelimit";
import { ManualClock } from "@celld/sec/ratelimit/testing";

Deno.test("local: keys are independent, and a refusal spends nothing", () => {
  const clock = new ManualClock();
  const limiter = new LocalLimiter({
    policies: [{ name: "m", limit: 2, window: "PT1M" }],
    now: clock.now,
  });
  assertEquals(limiter.limit("a").allowed, true);
  assertEquals(limiter.limit("a").allowed, true);
  assertEquals(limiter.limit("a").allowed, false);
  assertEquals(limiter.limit("b").remaining, 1);
  clock.advance(30_000);
  assertEquals(limiter.limit("a").allowed, true);
  assertEquals(limiter.limit("a").allowed, false);
});

Deno.test("local: peek asks, refund gives back, reset forgets", () => {
  const clock = new ManualClock();
  const limiter = new LocalLimiter({
    policies: [{ name: "m", limit: 3, window: "PT1H" }],
    now: clock.now,
  });
  limiter.limit("a", { cost: 3 });
  assertEquals(limiter.peek("a").allowed, false);
  assertEquals(limiter.peek("a", { cost: 0 }).remaining, 0);
  limiter.refund("a", { cost: 2 });
  assertEquals(limiter.peek("a", { cost: 2 }).allowed, true);
  assertEquals(limiter.peek("a", { cost: 3 }).allowed, false);
  limiter.reset("a");
  assertEquals(limiter.peek("a", { cost: 3 }).allowed, true);
  assertEquals(limiter.size, 0);
  // A refund of a key with nothing spent is nothing.
  limiter.refund("fresh");
  assertEquals(limiter.size, 0);
});

Deno.test("local: idle keys are dropped, and maxKeys forgets the least recent", () => {
  const clock = new ManualClock();
  const limiter = new LocalLimiter({
    policies: [{ name: "m", limit: 1, window: 1 }],
    now: clock.now,
    maxKeys: 2,
  });
  limiter.limit("a");
  limiter.limit("b");
  limiter.limit("a"); // refused, but a is now the most recent
  limiter.limit("c");
  assertEquals(limiter.size, 2);
  // b was forgotten, so it has its burst again; a was kept.
  assertEquals(limiter.peek("b").allowed, true);
  assertEquals(limiter.peek("a").allowed, false);
  clock.advance(1000);
  limiter.limit("a", { cost: 0 });
  assertEquals(limiter.size, 1);
});

Deno.test("local: pacing admits with a delay", () => {
  const clock = new ManualClock();
  const limiter = new LocalLimiter({
    policies: [{ name: "upstream", limit: 5, window: 1, burst: 1 }],
    now: clock.now,
  });
  const delays = [0, 1, 2, 3].map(() =>
    limiter.limit("svc", { maxDelayMs: 1000 }).delayMs
  );
  assertEquals(delays, [0, 200, 400, 600]);
});

Deno.test("local: costs by policy, charges past the burst, and holds", () => {
  const clock = new ManualClock();
  const limiter = new LocalLimiter({
    policies: [
      { name: "requests", limit: 60, window: "PT1M", burst: 2 },
      { name: "tokens", limit: 1000, window: 1 },
    ],
    now: clock.now,
  });
  const first = limiter.limit("svc", { cost: { requests: 1, tokens: 500 } });
  assertEquals(first.policies.map((p) => p.remaining), [1, 500]);
  limiter.charge("svc", { cost: { tokens: 1500 } });
  // 2,000 tokens against a burst of 1,000: a second of debt.
  const inDebt = limiter.limit("svc", { cost: { requests: 1 } });
  assertEquals([inDebt.allowed, inDebt.retryAfterMs], [false, 1000]);
  clock.advance(1000);
  assertEquals(limiter.limit("svc", { cost: { requests: 1 } }).allowed, true);
  limiter.hold("svc", { forMs: 5000 });
  limiter.hold("svc", { forMs: 1000 });
  const held = limiter.peek("svc", { cost: 0 });
  assertEquals([held.allowed, held.retryAfterMs], [false, 5000]);
  clock.advance(5000);
  assertEquals(limiter.limit("svc", { cost: { requests: 1 } }).allowed, true);
  // A hold alone keeps a key, until it ends.
  limiter.reset("svc");
  limiter.hold("svc", { forMs: 1000 });
  assertEquals(limiter.size, 1);
  clock.advance(1000);
  limiter.limit("svc", { cost: 0 });
  assertEquals(limiter.size, 0);
  // Reset lifts a hold.
  limiter.hold("svc", { forMs: 1000 });
  limiter.reset("svc");
  assertEquals(limiter.peek("svc").allowed, true);
});

Deno.test("local: bad options are refused", () => {
  const policies = [{ name: "m", limit: 2, window: 1 }];
  assertThrows(() => new LocalLimiter({ policies, maxKeys: 0 }), RangeError);
  assertThrows(() => new LocalLimiter({ policies, name: "a b" }), TypeError);
  const limiter = new LocalLimiter({ policies });
  assertThrows(() => limiter.limit(""), TypeError);
  assertThrows(() => limiter.limit("a", { cost: 3 }), RangeError, "burst of 2");
  assertThrows(() => limiter.limit("a", { cost: -1 }), RangeError);
  assertThrows(() => limiter.limit("a", { maxDelayMs: -1 }), RangeError);
  assertThrows(
    () => limiter.peek("a", { maxDelayMs: 5 } as never),
    TypeError,
    '"maxDelayMs"',
  );
  assertThrows(() => limiter.limit("a", { costs: 1 } as never), TypeError);
  assertThrows(
    () => limiter.limit("a", { cost: { n: 1 } }),
    TypeError,
    '"n"',
  );
  assertThrows(() => limiter.limit("a", { cost: { m: 3 } }), RangeError);
  assertThrows(() => limiter.limit("a", { cost: [1] as never }), TypeError);
  // A charge may pass the burst, up to a billion units.
  limiter.charge("a", { cost: 3 });
  assertThrows(() => limiter.charge("a", { cost: 2e9 }), RangeError);
  assertThrows(() => limiter.hold("a", { forMs: -1 }), RangeError);
  assertThrows(
    () => limiter.hold("a", { forMs: 401 * 86_400_000 }),
    RangeError,
  );
  assertThrows(() => limiter.hold("a", { ms: 5 } as never), TypeError);
});

Deno.test("memory: the same limiter behind promises, with errors as rejections", async () => {
  const clock = new ManualClock();
  const limiter = memoryLimiter({
    policies: [{ name: "m", limit: 1, window: 1 }],
    now: clock.now,
  });
  assertEquals(limiter.name, "memory");
  assertEquals((await limiter.limit("a")).allowed, true);
  assertEquals((await limiter.limit("a")).retryAfterMs, 1000);
  await limiter.refund("a");
  assertEquals((await limiter.peek("a")).allowed, true);
  await limiter.charge("a", { cost: 2 });
  assertEquals((await limiter.peek("a", { cost: 0 })).retryAfterMs, 1000);
  await limiter.reset("a");
  await limiter.hold("a", { forMs: 300 });
  assertEquals((await limiter.limit("a")).retryAfterMs, 300);
  await limiter.reset("a");
  const pending = limiter.limit("");
  await assertRejects(() => pending, TypeError);
  await assertRejects(() => limiter.hold("a", { forMs: NaN }), RangeError);
});
