// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "@celld/core/assert";
import {
  type KeyState,
  resolvePolicies,
  type ShardRequest,
} from "@celld/sec/ratelimit";
import {
  HOLD,
  ManualClock,
  MemoryShardStore,
  ShardCore,
} from "@celld/sec/ratelimit/testing";

const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);
const policies = resolvePolicies([
  { name: "burst", limit: 2, window: 1 },
  { name: "hour", limit: 5, window: "PT1H" },
]);

function request(overrides: Partial<ShardRequest> = {}): ShardRequest {
  return { key: KEY, policies, cost: 1, maxDelayMs: 0, ...overrides };
}

Deno.test("shard: decides with its own clock and stores one row per policy", () => {
  const clock = new ManualClock();
  const store = new MemoryShardStore();
  const shard = new ShardCore(store, clock.now);
  assertEquals(shard.limit(request()).decision.allowed, true);
  assertEquals(store.size, 2);
  assertEquals(shard.limit(request()).decision.allowed, true);
  const refused = shard.limit(request());
  assertEquals([refused.decision.allowed, refused.nextMs], [false, 500]);
  assertEquals(shard.peek(request({ cost: 0 })).decision.remaining, 0);
});

Deno.test("shard: questions and refusals write nothing", () => {
  const clock = new ManualClock();
  const store = new MemoryShardStore();
  const shard = new ShardCore(store, clock.now);
  shard.peek(request());
  assertEquals(store.size, 0);
  shard.limit(request({ cost: 2 }));
  const before = store.read(KEY, ["burst", "hour"]);
  shard.limit(request());
  assertEquals(store.read(KEY, ["burst", "hour"]), before);
});

Deno.test("shard: each write sweeps a few idle rows", () => {
  const clock = new ManualClock();
  const store = new MemoryShardStore();
  const shard = new ShardCore(store, clock.now);
  for (let i = 0; i < 20; i++) {
    shard.limit(request({ key: i.toString(16).padStart(64, "0") }));
  }
  assertEquals(store.size, 40);
  // The burst rows go idle after a second, the hourly ones after 12 minutes.
  clock.advance(1000);
  shard.limit(request({ key: OTHER }));
  assertEquals(store.size, 40 + 2 - 8);
  clock.advance(3_600_000);
  for (let i = 0; i < 4; i++) {
    shard.limit(request({ key: OTHER }));
    clock.advance(1000);
  }
  assertEquals(store.size, 2);
});

Deno.test("shard: refund and reset", () => {
  const clock = new ManualClock();
  const store = new MemoryShardStore();
  const shard = new ShardCore(store, clock.now);
  shard.limit(request({ cost: 2 }));
  shard.refund(request({ cost: 2 }));
  assertEquals(store.size, 0);
  shard.limit(request({ cost: 2 }));
  shard.reset({ key: KEY });
  assertEquals(store.size, 0);
});

Deno.test("shard: a refund or charge writes only the rows it changes", () => {
  const writes: string[][] = [];
  class Counting extends MemoryShardStore {
    override write(
      key: string,
      names: readonly string[],
      states: readonly (KeyState | null)[],
    ): void {
      writes.push([...names]);
      super.write(key, names, states);
    }
  }
  const clock = new ManualClock();
  const shard = new ShardCore(new Counting(), clock.now);
  shard.limit(request());
  shard.refund(request({ cost: { hour: 1 } }));
  shard.charge(request({ cost: { burst: 1 } }));
  shard.refund(request({ cost: 0 }));
  assertEquals(writes, [["burst", "hour"], ["hour"], ["burst"]]);
});

Deno.test("shard: a charge may pass the burst", () => {
  const clock = new ManualClock();
  const shard = new ShardCore(new MemoryShardStore(), clock.now);
  shard.charge(request({ cost: { hour: 7 } }));
  // Seven hourly units against a burst of five: the next waits three
  // intervals of 12 minutes.
  const refused = shard.limit(request());
  assertEquals(
    [refused.decision.allowed, refused.decision.retryAfterMs],
    [false, 3 * 720_000],
  );
});

Deno.test("shard: a hold is a row of its own, swept when it ends, and reset lifts it", () => {
  const clock = new ManualClock();
  const store = new MemoryShardStore();
  const shard = new ShardCore(store, clock.now);
  shard.hold({ key: KEY, forMs: 2000 });
  const [held] = store.read(KEY, [HOLD]);
  assertEquals(held && held.at + held.ahead, clock.now() + 2000);
  const refused = shard.limit(request());
  assertEquals(
    [refused.decision.allowed, refused.decision.retryAfterMs, refused.nextMs],
    [false, 2000, 2000],
  );
  assertEquals(store.size, 1);
  clock.advance(2000);
  assertEquals(shard.limit(request()).decision.allowed, true);
  // That write swept the finished hold.
  assertEquals(store.read(KEY, [HOLD]), [null]);
  assertEquals(store.size, 2);
  shard.hold({ key: KEY, forMs: 2000 });
  shard.reset({ key: KEY });
  assertEquals(store.size, 0);
});

Deno.test("shard: every request is checked again", () => {
  const shard = new ShardCore(new MemoryShardStore());
  assertThrows(
    () => shard.limit(request({ key: "alice" })),
    TypeError,
    "64 hex",
  );
  assertThrows(
    () => shard.limit(request({ key: KEY.toUpperCase() })),
    TypeError,
  );
  assertThrows(() => shard.limit(request({ cost: 3 })), RangeError, "burst");
  assertThrows(() => shard.limit(request({ maxDelayMs: -1 })), RangeError);
  assertThrows(
    () =>
      shard.limit(
        request({
          policies: [{ name: "x", limit: 1, windowMs: 0, burst: 1 }],
        }),
      ),
    RangeError,
    "window",
  );
  assertThrows(() => shard.limit(null as never), TypeError);
  assertThrows(() => shard.reset({ key: "../" }), TypeError);
  assertThrows(
    () => shard.limit(request({ cost: { nope: 1 } })),
    TypeError,
    '"nope"',
  );
  assertThrows(() => shard.charge(request({ cost: 2e9 })), RangeError);
  assertThrows(() => shard.hold({ key: "alice", forMs: 1 }), TypeError);
  assertThrows(() => shard.hold({ key: KEY, forMs: -1 }), RangeError);
  assertThrows(() => shard.hold(null as never), TypeError);
});
