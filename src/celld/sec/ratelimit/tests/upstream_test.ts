// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects, assertThrows } from "@celld/core/assert";
import { virtualRuntime } from "@celld/http/testing";
import {
  type Decision,
  memoryLimiter,
  type RateLimiter,
  UpstreamLimit,
} from "@celld/sec/ratelimit";

const policies = [
  { name: "requests", limit: 60, window: "PT1M", burst: 2 },
  { name: "tokens", limit: 1000, window: 1 },
];

function setup() {
  const runtime = virtualRuntime({ start: 0 });
  const limiter = memoryLimiter({ policies, now: runtime.now });
  const limit = new UpstreamLimit(limiter, {
    key: "account",
    cost: { requests: 1 },
  });
  return { runtime, limiter, limit };
}

Deno.test("upstream: admit sleeps out refusals within the deadline", async () => {
  const { runtime, limit } = setup();
  for (let i = 0; i < 3; i++) {
    assertEquals(await limit.admit({ deadline: 30_000, runtime }), "admitted");
  }
  // Two at once, then one a second.
  assertEquals(runtime.sleeps, [1000]);
});

Deno.test("upstream: a wait that would reach the deadline is refused at once", async () => {
  const { runtime, limit } = setup();
  await limit.hold(60_000);
  assertEquals(await limit.admit({ deadline: 30_000, runtime }), "refused");
  assertEquals(runtime.sleeps, []);
  // With the hold inside the deadline, it is waited out.
  assertEquals(await limit.admit({ deadline: 90_000, runtime }), "admitted");
  assertEquals(runtime.sleeps, [60_000]);
});

Deno.test("upstream: charges, refunds and give-backs reach the key", async () => {
  const { runtime, limiter, limit } = setup();
  await limit.admit({ deadline: 1000, runtime });
  await limit.charge({ tokens: 1500 });
  const inDebt = await limiter.peek("account", { cost: 0 });
  assertEquals([inDebt.allowed, inDebt.retryAfterMs], [false, 500]);
  await limit.refund({ tokens: 500 });
  assertEquals((await limiter.peek("account", { cost: 0 })).allowed, true);
  await limit.giveBack();
  assertEquals(
    (await limiter.peek("account", { cost: 0 })).policies[0].remaining,
    2,
  );
});

Deno.test("upstream: a failing limiter is reported and never stops a call", async () => {
  const errors: string[] = [];
  const failing: RateLimiter = {
    ...memoryLimiter({ policies }),
    limit: () => Promise.reject(new Error("limit")),
    charge: () => {
      throw new Error("charge");
    },
    refund: () => Promise.reject(new Error("refund")),
    hold: () => Promise.reject(new Error("hold")),
  };
  const runtime = virtualRuntime();
  const deadline = runtime.now() + 1000;
  const limit = new UpstreamLimit(failing, {
    onError: (error) => errors.push((error as Error).message),
  });
  assertEquals(await limit.admit({ deadline, runtime }), "unavailable");
  await limit.charge(1);
  await limit.giveBack();
  await limit.hold(10);
  assertEquals(errors, ["limit", "charge", "refund", "hold"]);
  // A reporter that throws changes nothing either.
  const loud = new UpstreamLimit(failing, {
    onError: () => {
      throw new Error("reporter");
    },
  });
  assertEquals(await loud.admit({ deadline, runtime }), "unavailable");
  await loud.hold(10);
});

Deno.test("upstream: an abandoned wait gives back an admission that comes late", async () => {
  const grant = Promise.withResolvers<Decision>();
  const refunds: unknown[] = [];
  const slow: RateLimiter = {
    ...memoryLimiter({ policies }),
    limit: () => grant.promise,
    refund: (_key, options) => {
      refunds.push(options?.cost);
      return Promise.resolve();
    },
  };
  const limit = new UpstreamLimit(slow, { cost: { requests: 1 } });
  const runtime = virtualRuntime();
  const abort = new AbortController();
  const pending = limit.admit({
    deadline: runtime.now() + 1000,
    runtime,
    signal: abort.signal,
  });
  abort.abort(new Error("stop"));
  await assertRejects(() => pending, Error, "stop");
  grant.resolve({
    allowed: true,
    delayMs: 0,
    retryAfterMs: 0,
    remaining: 1,
    policies: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(refunds, [{ requests: 1 }]);
});

Deno.test("upstream: the limiter, key and cost are checked at construction", () => {
  assertThrows(
    () => new UpstreamLimit({ limit() {} } as never),
    TypeError,
    "@celld/sec/ratelimit limiter",
  );
  const limiter = memoryLimiter({ policies });
  assertThrows(() => new UpstreamLimit(limiter, { key: "" }), TypeError);
  assertThrows(
    () => new UpstreamLimit(limiter, { cost: { nope: 1 } }),
    TypeError,
    '"nope"',
  );
  assertThrows(() => new UpstreamLimit(limiter, { cost: 3 }), RangeError);
  const derived = new UpstreamLimit(limiter, {
    cost: (list) =>
      Object.fromEntries(
        list.map((policy) => [policy.name, policy.name === "tokens" ? 5 : 1]),
      ),
  });
  assertEquals([derived.key, derived.cost], ["default", {
    requests: 1,
    tokens: 5,
  }]);
});
