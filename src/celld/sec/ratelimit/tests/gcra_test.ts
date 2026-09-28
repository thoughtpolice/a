// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import {
  charge,
  evaluate,
  hold,
  type KeyState,
  MAX_WINDOW_MS,
  refund,
  type ResolvedPolicy,
  resolvePolicies,
} from "@celld/sec/ratelimit";

const T0 = Date.UTC(2026, 8, 28, 12);

function policies(...list: Parameters<typeof resolvePolicies>[0]) {
  return resolvePolicies(list);
}

/** Runs requests through `evaluate`, keeping the state between them. */
class Key {
  states: (KeyState | null)[];
  constructor(readonly policies: readonly ResolvedPolicy[]) {
    this.states = policies.map(() => null);
  }
  take(
    now: number,
    cost: number | readonly number[] = 1,
    maxDelayMs = 0,
    held: KeyState | null = null,
  ) {
    const result = evaluate(this.policies, this.states, now, cost, {
      maxDelayMs,
      hold: held,
    });
    this.states = [...result.states];
    return result;
  }
}

/** A state's TAT, or null when idle. */
function tat(state: KeyState | null): number | null {
  return state === null ? null : state.at + state.ahead;
}

Deno.test("gcra: a burst at once, then one unit per interval", () => {
  const key = new Key(policies({ name: "m", limit: 10, window: "PT1M" }));
  for (let i = 0; i < 10; i++) {
    const { decision } = key.take(T0);
    assertEquals([decision.allowed, decision.remaining], [true, 9 - i]);
  }
  const refused = key.take(T0).decision;
  assertEquals(refused.allowed, false);
  assertEquals(refused.retryAfterMs, 6000);
  assertEquals(refused.policies[0].resetMs, 60_000);
  assertEquals(key.take(T0 + 5999).decision.allowed, false);
  const next = key.take(T0 + 6000).decision;
  assertEquals([next.allowed, next.remaining], [true, 0]);
});

Deno.test("gcra: remaining and reset after part of a burst", () => {
  const key = new Key(policies({ name: "m", limit: 10, window: "PT1M" }));
  key.take(T0, 3);
  const { decision } = key.take(T0, 0);
  assertEquals(decision.remaining, 7);
  assertEquals(decision.policies[0].resetMs, 18_000);
  // Half an interval later, still 7 whole units; a full one gives one back.
  assertEquals(key.take(T0 + 3000, 0).decision.remaining, 7);
  assertEquals(key.take(T0 + 6000, 0).decision.remaining, 8);
});

Deno.test("gcra: a burst smaller than the limit", () => {
  const key = new Key(
    policies({ name: "m", limit: 60, window: "PT1M", burst: 2 }),
  );
  assertEquals(key.take(T0).decision.allowed, true);
  assertEquals(key.take(T0).decision.allowed, true);
  const refused = key.take(T0).decision;
  assertEquals([refused.allowed, refused.retryAfterMs], [false, 1000]);
  assertEquals(key.take(T0 + 1000).decision.allowed, true);
});

Deno.test("gcra: every policy must admit, and a refusal charges none", () => {
  const key = new Key(policies(
    { name: "second", limit: 2, window: 1 },
    { name: "hour", limit: 3, window: "PT1H" },
  ));
  assertEquals(key.take(T0).decision.allowed, true);
  assertEquals(key.take(T0).decision.allowed, true);
  const bySecond = key.take(T0).decision;
  assertEquals(bySecond.allowed, false);
  assertEquals(bySecond.retryAfterMs, 500);
  // The refusal did not spend the hourly unit.
  assertEquals(bySecond.policies[1].remaining, 1);
  assertEquals(key.take(T0 + 1000).decision.allowed, true);
  const byHour = key.take(T0 + 2000).decision;
  assertEquals(byHour.allowed, false);
  assertEquals(byHour.retryAfterMs, 1_200_000 - 2000);
  assertEquals(byHour.remaining, 0);
  assertEquals(byHour.policies.map((p) => p.remaining), [2, 0]);
});

Deno.test("gcra: an allowed delay reserves slots in order, up to the limit", () => {
  const key = new Key(
    policies({ name: "pace", limit: 1, window: 1, burst: 1 }),
  );
  assertEquals(key.take(T0, 1, 5000).decision.delayMs, 0);
  assertEquals(key.take(T0, 1, 5000).decision.delayMs, 1000);
  assertEquals(key.take(T0, 1, 5000).decision.delayMs, 2000);
  const refused = key.take(T0, 1, 2500).decision;
  assertEquals([refused.allowed, refused.retryAfterMs], [false, 3000]);
  // A reserved future leaves nothing now.
  assertEquals(key.take(T0, 0).decision.remaining, 0);
});

Deno.test("gcra: a question moves nothing", () => {
  const list = policies({ name: "m", limit: 2, window: 1 });
  const first = evaluate(list, [null], T0, 2, { commit: false });
  assertEquals(first.decision.allowed, true);
  assertEquals([first.states, first.changed], [[null], false]);
  const state = { at: T0 - 500, ahead: 1500 };
  const second = evaluate(list, [state], T0, 1, { commit: false });
  assertEquals(second.decision.allowed, false);
  assert(second.states[0] === state, "the same state, not a copy");
  assertEquals(second.changed, false);
});

Deno.test("gcra: a refusal changes nothing to write", () => {
  const key = new Key(policies({ name: "m", limit: 1, window: 1 }));
  assertEquals(key.take(T0).changed, true);
  assertEquals(key.take(T0).changed, false);
});

Deno.test("gcra: an idle key keeps no state", () => {
  const key = new Key(policies({ name: "m", limit: 2, window: 1 }));
  key.take(T0);
  assertEquals(tat(key.states[0]), T0 + 500);
  const later = key.take(T0 + 10_000, 0);
  assertEquals(later.states, [null]);
  assertEquals(later.decision.policies[0].resetMs, 0);
  assertEquals(later.nextMs, 0);
  // An idle state is dropped even by a question.
  const asked = evaluate(key.policies, [{ at: T0, ahead: 500 }], T0 + 600, 1, {
    commit: false,
  });
  assertEquals([asked.states, asked.changed], [[null], true]);
});

Deno.test("gcra: nextMs is when one unit would be admitted", () => {
  const key = new Key(policies({ name: "m", limit: 4, window: 4 }));
  key.take(T0, 4);
  const refused = key.take(T0, 3);
  assertEquals(refused.decision.retryAfterMs, 3000);
  assertEquals(refused.nextMs, 1000);
});

Deno.test("gcra: refunds give units back, never past now", () => {
  const list = policies({ name: "m", limit: 10, window: 10 });
  const spent = evaluate(list, [null], T0, 5).states;
  assertEquals(spent.map(tat), [T0 + 5000]);
  assertEquals(refund(list, spent, T0, 2).map(tat), [T0 + 3000]);
  assertEquals(refund(list, spent, T0 + 1000, 2).map(tat), [T0 + 3000]);
  assertEquals(refund(list, spent, T0, 5), [null]);
  assertEquals(refund(list, spent, T0 + 4000, 2), [null]);
  assertEquals(refund(list, [null], T0, 1), [null]);
  // A policy the cost has no share of keeps its state object, so a store
  // can skip writing it.
  const two = policies(
    { name: "a", limit: 10, window: 10 },
    { name: "b", limit: 10, window: 10 },
  );
  const both = evaluate(two, [null, null], T0, 5).states;
  const back = refund(two, both, T0, [2, 0]);
  assert(back[1] === both[1], "a refund leaves b alone");
  assertEquals(back.map(tat), [T0 + 3000, T0 + 5000]);
  const more = charge(two, both, T0, [0, 2]);
  assert(more[0] === both[0], "a charge leaves a alone");
  assertEquals(charge(two, both, T0 + 5000, [0, 1]), [null, {
    at: T0 + 5000,
    ahead: 1000,
  }]);
});

Deno.test("gcra: costs by policy, where a share of 0 only asks about debt", () => {
  const key = new Key(policies(
    { name: "requests", limit: 60, window: "PT1M", burst: 2 },
    { name: "tokens", limit: 1000, window: 1 },
  ));
  const first = key.take(T0, [1, 800]).decision;
  assertEquals(first.policies.map((p) => p.remaining), [1, 200]);
  // 200 tokens are left, so 800 more wait 600 ms.
  const refused = key.take(T0, [1, 800]).decision;
  assertEquals([refused.allowed, refused.retryAfterMs], [false, 600]);
  // A request of no tokens is admitted, and leaves the tokens alone.
  assertEquals(key.take(T0, [1, 0]).decision.allowed, true);
  assertEquals(key.states.map(tat), [T0 + 2000, T0 + 800]);
});

Deno.test("gcra: a charge spends past the burst, and the debt refuses until paid", () => {
  const list = policies({ name: "tokens", limit: 1000, window: 1 });
  const key = new Key(list);
  key.states = charge(list, key.states, T0, 1500);
  // 1,500 tokens against a burst of 1,000: 500 of debt, half a second.
  const refused = key.take(T0, 0).decision;
  assertEquals(
    [refused.allowed, refused.retryAfterMs, refused.remaining],
    [false, 500, 0],
  );
  assertEquals(key.take(T0 + 499, 0).decision.allowed, false);
  assertEquals(key.take(T0 + 500, 0).decision.allowed, true);
  // Charges add up, from the TAT or from now.
  assertEquals(charge(list, key.states, T0 + 500, 100).map(tat), [T0 + 1600]);
  assertEquals(charge(list, [null], T0, 0), [null]);
  // Debt stops 400 days past the burst.
  const daily = policies({ name: "d", limit: 1, window: "P1D" });
  assertEquals(
    charge(daily, [null], T0, 10_000).map(tat),
    [T0 + 86_400_000 + MAX_WINDOW_MS],
  );
});

Deno.test("gcra: a hold refuses everything until it ends, and spends nothing", () => {
  const list = policies({ name: "m", limit: 10, window: 1 });
  const held = hold(null, T0, 2000);
  assertEquals(tat(held), T0 + 2000);
  const refused = evaluate(list, [null], T0 + 500, 1, { hold: held });
  assertEquals(
    [
      refused.decision.allowed,
      refused.decision.retryAfterMs,
      refused.decision.remaining,
      refused.nextMs,
    ],
    [false, 1500, 0, 1500],
  );
  assertEquals([refused.states, refused.changed], [[null], false]);
  // The policy's state is untouched, but nothing can be spent until the
  // hold ends, which each policy's status says too.
  assertEquals(
    [
      refused.decision.policies[0].remaining,
      refused.decision.policies[0].resetMs,
    ],
    [0, 1500],
  );
  // Even a question of nothing is refused while held.
  assertEquals(
    evaluate(list, [null], T0 + 500, 0, { hold: held }).decision.allowed,
    false,
  );
  // When it ends, the burst is all there.
  assertEquals(
    evaluate(list, [null], T0 + 2000, 10, { hold: held }).decision.allowed,
    true,
  );
});

Deno.test("gcra: a hold is never shortened, and none lasts past its end", () => {
  const first = hold(null, T0, 2000);
  assertEquals(tat(hold(first, T0 + 500, 1000)), T0 + 2000);
  assertEquals(tat(hold(first, T0 + 500, 3000)), T0 + 3500);
  assertEquals(hold(first, T0 + 2000, 0), null);
  assertEquals(hold(null, T0, 0), null);
});

Deno.test("gcra: requests that may wait out a hold are spaced after it", () => {
  const key = new Key(
    policies({ name: "pace", limit: 1, window: 1, burst: 1 }),
  );
  const held = hold(null, T0, 10_000);
  const delays = [0, 1, 2].map(() =>
    key.take(T0, 1, 60_000, held).decision.delayMs
  );
  // Not three at once when the hold ends: one a second from then.
  assertEquals(delays, [10_000, 11_000, 12_000]);
});

/** A small deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

Deno.test("gcra: no span of time admits more than burst plus the rate", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const random = prng(seed);
    const limit = 1 + Math.floor(random() * 20);
    const windowMs = 100 + Math.floor(random() * 5000);
    const burst = 1 + Math.floor(random() * limit * 2);
    const list = policies({ name: "p", limit, window: windowMs / 1000, burst });
    const key = new Key(list);
    const admitted: [number, number][] = [];
    let now = T0;
    for (let i = 0; i < 400; i++) {
      now += Math.floor(random() * windowMs / limit * 2);
      const cost = 1 + Math.floor(random() * Math.min(3, burst));
      if (key.take(now, cost).decision.allowed) admitted.push([now, cost]);
    }
    assert(admitted.length > 50, `seed ${seed} admitted enough to matter`);
    const interval = list[0].windowMs / limit;
    for (let i = 0; i < admitted.length; i++) {
      let spent = 0;
      for (let j = i; j < admitted.length; j++) {
        spent += admitted[j][1];
        const span = admitted[j][0] - admitted[i][0];
        assert(
          spent <= burst + span / interval + 1e-6,
          `seed ${seed}: ${spent} units over ${span} ms exceeds burst ${burst} + rate`,
        );
      }
    }
  }
});

Deno.test("gcra: retryAfterMs is exact: sooner is refused, then admitted", () => {
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const random = prng(seed);
    const limit = 1 + Math.floor(random() * 10);
    const windowMs = 1000 * (1 + Math.floor(random() * 10));
    const list = policies({ name: "p", limit, window: windowMs / 1000 });
    const key = new Key(list);
    let now = T0;
    for (let i = 0; i < 100; i++) {
      now += Math.floor(random() * 3000);
      const cost = 1 + Math.floor(random() * limit);
      const { decision } = key.take(now, cost);
      if (decision.allowed) continue;
      const wait = decision.retryAfterMs;
      const probe = new Key(list);
      probe.states = [...key.states];
      if (wait > 1) {
        assertEquals(
          probe.take(now + wait - 1, cost).decision.allowed,
          false,
          `seed ${seed}: 1 ms early`,
        );
      }
      assertEquals(
        probe.take(now + wait, cost).decision.allowed,
        true,
        `seed ${seed}: on time`,
      );
    }
  }
});

Deno.test("gcra: retryAfterMs stays exact with costs by policy and holds", () => {
  for (const seed of [21, 22, 23, 24, 25, 26]) {
    const random = prng(seed);
    const list = policies(
      { name: "a", limit: 1 + Math.floor(random() * 10), window: 1 },
      {
        name: "b",
        limit: 10 + Math.floor(random() * 100),
        window: 1 + Math.floor(random() * 10),
      },
    );
    const key = new Key(list);
    let held: KeyState | null = null;
    let now = T0;
    for (let i = 0; i < 200; i++) {
      now += Math.floor(random() * 1500);
      if (random() < 0.1) held = hold(held, now, Math.floor(random() * 3000));
      const cost = list.map((policy) =>
        Math.floor(random() * (policy.burst + 1))
      );
      if (random() < 0.2) key.states = charge(list, key.states, now, cost);
      const { decision } = key.take(now, cost, 0, held);
      if (decision.allowed) continue;
      const wait = decision.retryAfterMs;
      const probe = new Key(list);
      probe.states = [...key.states];
      if (wait > 1) {
        assertEquals(
          probe.take(now + wait - 1, cost, 0, held).decision.allowed,
          false,
          `seed ${seed}: 1 ms early`,
        );
      }
      assertEquals(
        probe.take(now + wait, cost, 0, held).decision.allowed,
        true,
        `seed ${seed}: on time`,
      );
    }
  }
});

Deno.test("gcra: a million units a second stay exact at epoch times", () => {
  // An epoch millisecond count rounds to about 0.24 us, a quarter of this
  // interval: stored as a TAT, each unit would drift by 2%.
  const key = new Key(
    policies({ name: "tokens", limit: 1_000_000, window: 1, burst: 1000 }),
  );
  let admitted = 0;
  while (key.take(T0).decision.allowed) admitted++;
  assertEquals(admitted, 1000);
  for (let ms = 1; ms <= 50; ms++) {
    admitted = 0;
    while (key.take(T0 + ms).decision.allowed) admitted++;
    assertEquals(admitted, 1000, `millisecond ${ms}`);
  }
});
