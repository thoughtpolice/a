// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  DEFAULT_PACER_CONFIG,
  durablePacer,
  exhaustedUntil,
  memoryPacer,
  type PacerApi,
  PacerState,
  parseRateLimitEvent,
  parseRateLimitHeaders,
  resolvePacerConfig,
  usageResetAt,
} from "@celld/api/openai";
import { GptConversations, GptPacer } from "@celld/api/openai/durable";

function granted(decision: ReturnType<PacerState["acquire"]>): string {
  assert(decision.granted, `expected a grant, got ${JSON.stringify(decision)}`);
  return decision.lease;
}

Deno.test("defaults and config checks", () => {
  assertEquals(DEFAULT_PACER_CONFIG.maxConcurrent, 4);
  let message = "";
  try {
    resolvePacerConfig({ maxConcurrent: 0 });
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message, "maxConcurrent must be a positive integer, got 0");
});

Deno.test("concurrency: leases up to the limit, then busy until one is released", () => {
  const state = new PacerState({ maxConcurrent: 2 });
  const a = granted(state.acquire(0, 60_000, "a"));
  granted(state.acquire(0, 60_000, "b"));
  const busy = state.acquire(0, 60_000, "c");
  assertEquals(busy, {
    granted: false,
    waitMs: 1000,
    reason: "busy",
    block: null,
  });
  state.release(10, { lease: a });
  granted(state.acquire(10, 60_000, "c"));
});

Deno.test("a lease that is never released expires", () => {
  const state = new PacerState({ maxConcurrent: 1 });
  granted(state.acquire(0, 500, "lost"));
  assertEquals(state.acquire(100, 500, "x").granted, false);
  granted(state.acquire(500, 500, "x"));
});

Deno.test("lease lengths are capped by maxLeaseMs", () => {
  const state = new PacerState({ maxConcurrent: 1, maxLeaseMs: 1000 });
  granted(state.acquire(0, 999_999, "a"));
  granted(state.acquire(1000, 10, "b"));
});

Deno.test("spacing holds starts minIntervalMs apart", () => {
  const state = new PacerState({ minIntervalMs: 300 });
  granted(state.acquire(1000, 1000, "a"));
  assertEquals(state.acquire(1100, 1000, "b"), {
    granted: false,
    waitMs: 200,
    reason: "spacing",
    block: null,
  });
  granted(state.acquire(1300, 1000, "b"));
});

Deno.test("a usage limit blocks everyone until its reset", () => {
  const state = new PacerState();
  const lease = granted(state.acquire(0, 1000, "a"));
  state.release(0, {
    lease,
    error: {
      kind: "usage_limit",
      code: "usage_limit_reached",
      retryAfterMs: null,
      resetsAt: 3_600_000,
    },
  });
  const held = state.acquire(1000, 1000, "b");
  assertEquals(held, {
    granted: false,
    waitMs: 3_599_000,
    reason: "blocked",
    block: {
      until: 3_600_000,
      reason: "usage_limit",
      code: "usage_limit_reached",
    },
  });
  granted(state.acquire(3_600_000, 1000, "b"));
  assertEquals(state.snapshot(3_600_000).totals.usageLimits, 1);
});

Deno.test("a usage limit with no reset time holds for unknownResetBlockMs", () => {
  const state = new PacerState({ unknownResetBlockMs: 5000 });
  state.release(100, {
    lease: "x",
    error: {
      kind: "usage_limit",
      code: null,
      retryAfterMs: null,
      resetsAt: null,
    },
  });
  assertEquals(state.snapshot(100).block?.until, 5100);
});

Deno.test("retry-after on rate limits and overload holds everyone briefly", () => {
  const state = new PacerState();
  state.release(0, {
    lease: "x",
    error: {
      kind: "overloaded",
      code: "server_is_overloaded",
      retryAfterMs: 2000,
      resetsAt: null,
    },
  });
  assertEquals(state.snapshot(0).block, {
    until: 2000,
    reason: "overloaded",
    code: "server_is_overloaded",
  });
  // Other failures do not block.
  const other = new PacerState();
  other.release(0, {
    lease: "x",
    error: { kind: "server", code: null, retryAfterMs: 5000, resetsAt: null },
  });
  assertEquals(other.snapshot(0).block, null);
});

Deno.test("headers saying a window is spent block until it resets", () => {
  const state = new PacerState();
  state.release(1_000, {
    lease: "x",
    rateLimits: [{
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 100, windowMinutes: 300, resetsAt: 50_000 },
      secondary: null,
      credits: null,
      planType: null,
    }],
  });
  assertEquals(state.snapshot(1_000).block?.reason, "exhausted");
  assertEquals(state.snapshot(1_000).rateLimits[0].primary?.usedPercent, 100);
});

Deno.test("a later block wins; an earlier one does not shorten it", () => {
  const state = new PacerState();
  assertEquals(state.block(0, { until: 5000, reason: "a", code: null }), true);
  assertEquals(state.block(0, { until: 3000, reason: "b", code: null }), false);
  assertEquals(state.block(0, { until: 9000, reason: "c", code: null }), true);
  assertEquals(
    state.block(10_000, { until: 5000, reason: "past", code: null }),
    false,
  );
  state.unblock();
  assertEquals(state.snapshot(0).block, null);
});

Deno.test("usage totals accumulate across releases", () => {
  const state = new PacerState();
  const usage = {
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 3,
    reasoningTokens: 1,
    totalTokens: 13,
  };
  state.release(0, { lease: "a", usage });
  state.release(0, {
    lease: "b",
    usage,
    error: { kind: "server", code: null, retryAfterMs: null, resetsAt: null },
  });
  assertEquals(state.snapshot(0).totals, {
    calls: 2,
    failures: 1,
    usageLimits: 0,
    inputTokens: 20,
    cachedInputTokens: 8,
    outputTokens: 6,
    reasoningTokens: 2,
  });
});

Deno.test("state restores from a stored block, totals and windows", () => {
  const state = new PacerState({}, {
    block: { until: 10_000, reason: "usage_limit", code: null },
    totals: {
      calls: 5,
      failures: 0,
      usageLimits: 1,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    },
  });
  assertEquals(state.acquire(0, 1000, "a").granted, false);
  assertEquals(state.snapshot(0).totals.calls, 5);
});

Deno.test("memoryPacer runs the state on a clock", async () => {
  let now = 0;
  const pacer = memoryPacer({ now: () => now, config: { maxConcurrent: 1 } });
  const first = await pacer.acquire({ leaseMs: 1000 });
  assert(first.granted, "granted");
  assertEquals((await pacer.acquire({ leaseMs: 1000 })).granted, false);
  now = 2000;
  assertEquals((await pacer.acquire({ leaseMs: 1000 })).granted, true);
  assertEquals(pacer.configure({ maxConcurrent: 3 }).maxConcurrent, 3);
});

Deno.test("durablePacer forwards to the named object", async () => {
  const calls: unknown[] = [];
  const stub = {
    acquire: (request: unknown) => {
      calls.push(["acquire", request]);
      return Promise.resolve({ granted: true, lease: "L" });
    },
    release: (report: unknown) => {
      calls.push(["release", report]);
      return Promise.resolve();
    },
  };
  const names: string[] = [];
  const namespace = {
    getByName(name: string) {
      names.push(name);
      return stub;
    },
  } as unknown as DurableObjectNamespace<PacerApi>;
  const pacer = durablePacer(namespace, "subscription-1");
  assertEquals(await pacer.acquire({ leaseMs: 5 }), {
    granted: true,
    lease: "L",
  });
  await pacer.release({ lease: "L" });
  assertEquals(names, ["subscription-1", "subscription-1"]);
  assertEquals(calls, [["acquire", { leaseMs: 5 }], ["release", {
    lease: "L",
  }]]);
});

Deno.test("the Durable Object classes load under the fake runtime", () => {
  // The real objects run in tests/runtime_test.py; here only their shape.
  const pacer = Object.getOwnPropertyNames(GptPacer.prototype);
  for (
    const name of [
      "acquire",
      "release",
      "block",
      "unblock",
      "configure",
      "snapshot",
    ]
  ) {
    assert(pacer.includes(name), name);
  }
  const conversations = Object.getOwnPropertyNames(GptConversations.prototype);
  for (const name of ["load", "save", "append", "remove", "list"]) {
    assert(conversations.includes(name), name);
  }
});

Deno.test("rate-limit headers: the codex family, other families, credits", () => {
  const snapshots = parseRateLimitHeaders(
    new Headers({
      "x-codex-primary-used-percent": "12.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1704069000",
      "x-codex-secondary-used-percent": "80",
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-unlimited": "0",
      "x-codex-credits-balance": " 12.00 ",
      "x-codex-bengalfox-primary-used-percent": "5",
      "x-codex-bengalfox-limit-name": "gpt-6-astra-fast",
    }),
  );
  assertEquals(snapshots, [
    {
      limitId: "codex",
      limitName: null,
      primary: {
        usedPercent: 12.5,
        windowMinutes: 300,
        resetsAt: 1_704_069_000_000,
      },
      secondary: { usedPercent: 80, windowMinutes: null, resetsAt: null },
      credits: { hasCredits: true, unlimited: false, balance: "12.00" },
      planType: null,
    },
    {
      limitId: "codex_bengalfox",
      limitName: "gpt-6-astra-fast",
      primary: { usedPercent: 5, windowMinutes: null, resetsAt: null },
      secondary: null,
      credits: null,
      planType: null,
    },
  ]);
});

Deno.test("rate-limit headers: nothing, zeros and junk give no snapshot", () => {
  assertEquals(parseRateLimitHeaders(new Headers()), []);
  assertEquals(
    parseRateLimitHeaders(new Headers({ "x-codex-primary-used-percent": "0" })),
    [],
  );
  assertEquals(
    parseRateLimitHeaders(
      new Headers({ "x-codex-primary-used-percent": "lots" }),
    ),
    [],
  );
});

Deno.test("rate-limit events and reset helpers", () => {
  assertEquals(parseRateLimitEvent({ type: "other" }), null);
  const event = parseRateLimitEvent({
    type: "codex.rate_limits",
    metered_limit_name: "Codex-Other",
    rate_limits: { secondary: { used_percent: 100, reset_at: 20 } },
    credits: { has_credits: false, unlimited: false },
  });
  assertEquals([
    event?.limitId,
    event?.secondary?.resetsAt,
    event?.credits?.balance,
  ], ["codex_other", 20_000, null]);
  assertEquals(usageResetAt([event!], "codex-other"), 20_000);
  assertEquals(usageResetAt([], null), null);
  assertEquals(exhaustedUntil([event!], 10_000), 20_000);
  assertEquals(exhaustedUntil([event!], 30_000), null);
});
