// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import {
  backoffDelay,
  type HttpRetryPolicy,
  parseRetryAfter,
  resolveRetryPolicy,
  type RetryOptions,
  type RetryPolicy,
} from "@celld/http";

// jev's defaults: the TypeSafe SDKs', less 408.
const JEV: HttpRetryPolicy = Object.freeze({
  maxRetries: 2,
  backoffInitialMs: 500,
  backoffMaxMs: 5_000,
  backoffJitter: 0.25,
  statuses: Object.freeze([
    429,
    ...Array.from({ length: 100 }, (_, index) => 500 + index),
  ]),
  respectRetryAfter: true,
  maxRetryAfterMs: 60_000,
  retryConnectionErrors: true,
  retryTimeouts: true,
  budgetMs: 30_000,
});

const jev = (options: RetryOptions = {}) => resolveRetryPolicy(options, JEV);

// openai's shape: failure kinds instead of statuses.
type Kind = "rate_limited" | "server" | "timeout";
interface KindPolicy extends RetryPolicy {
  readonly retryOn: readonly Kind[];
}
const OPENAI: KindPolicy = Object.freeze({
  maxRetries: 4,
  backoffInitialMs: 500,
  backoffMaxMs: 20_000,
  backoffJitter: 0.2,
  retryOn: Object.freeze(["rate_limited", "server", "timeout"] as Kind[]),
  respectRetryAfter: true,
  maxRetryAfterMs: 120_000,
  budgetMs: null,
});

Deno.test("the defaults come back resolved and frozen", () => {
  const policy = jev();
  assertEquals(policy, JEV);
  assert(Object.isFrozen(policy), "frozen policy");
  assert(Object.isFrozen(policy.statuses), "frozen statuses");
  assertEquals(resolveRetryPolicy(undefined, OPENAI), OPENAI);
});

Deno.test("partial policies fill from the defaults and are checked", () => {
  const policy = jev({ maxRetries: 5, statuses: new Set([503, 429, 503]) });
  assertEquals([policy.maxRetries, policy.statuses], [5, [429, 503]]);
  assertEquals(policy.backoffInitialMs, 500);
  assertEquals(
    assertThrows(() => jev({ backoffJitter: 2 }), RangeError).message,
    "retry.backoffJitter must be a finite number from 0 to 1, got 2",
  );
  assertEquals(
    assertThrows(() => jev({ maxRetries: 1.5 }), RangeError).message,
    "retry.maxRetries must be a non-negative integer, got 1.5",
  );
  assertEquals(
    assertThrows(() => jev({ statuses: [42] }), RangeError).message,
    "retry.statuses has a non-status 42",
  );
  assertEquals(
    assertThrows(() => jev({ budgetMs: 0 }), RangeError).message,
    "retry.budgetMs must be a finite number from 1, got 0",
  );
  for (
    const bad of [
      { maxRetries: -1 },
      { statuses: [99] },
      { statuses: [600] },
      { backoffInitialMs: Number.NaN },
      { backoffMaxMs: Number.POSITIVE_INFINITY },
      { maxRetryAfterMs: -1 },
    ]
  ) {
    assertThrows(() => jev(bad), RangeError).message;
  }
  assertEquals(jev({ budgetMs: null }).budgetMs, null);
});

Deno.test("undefined means the default; booleans and lists are typed", () => {
  const policy = jev({
    maxRetries: undefined,
    budgetMs: undefined,
    respectRetryAfter: undefined,
    statuses: undefined,
  });
  assertEquals(policy, JEV);
  assertEquals(
    assertThrows(
      () => jev({ retryTimeouts: "no" as unknown as boolean }),
      RangeError,
    ).message,
    "retry.retryTimeouts must be a boolean, got no",
  );
  assertEquals(
    assertThrows(
      () => jev({ statuses: 503 as unknown as number[] }),
      RangeError,
    ).message,
    "retry.statuses must be iterable, got 503",
  );
});

Deno.test("fields beyond the defaults' are dropped", () => {
  const policy = jev({ retryOn: ["x"] } as unknown as RetryOptions);
  assert(!("retryOn" in policy), "unknown option dropped");
});

Deno.test("a client's own list field is deduplicated in order", () => {
  const policy = resolveRetryPolicy(
    { retryOn: new Set<Kind>(["timeout", "server", "timeout"]) },
    OPENAI,
  );
  assertEquals(policy.retryOn, ["timeout", "server"]);
  assert(Object.isFrozen(policy.retryOn), "frozen");
  assertEquals(resolveRetryPolicy({ retryOn: [] }, OPENAI).retryOn, []);
  assertEquals(
    resolveRetryPolicy({ maxRetries: 0 }, OPENAI).retryOn,
    OPENAI.retryOn,
  );
});

Deno.test("backoff doubles to the cap, less jitter", () => {
  const exact = jev({ backoffJitter: 0 });
  assertEquals(
    [0, 1, 2, 3, 4, 100].map((retry) => backoffDelay(exact, retry, 0.9)),
    [500, 1000, 2000, 4000, 5000, 5000],
  );
  assertEquals(backoffDelay(JEV, 0, 0), 500);
  assertEquals(backoffDelay(JEV, 0, 1), 375);
  const full = jev({ backoffJitter: 1 });
  assertEquals(backoffDelay(full, 1, 0.5), 500);
  assertEquals(backoffDelay(full, 1, 0.999), 1);
  assertEquals(backoffDelay(full, 0, 1), 0);
  const small = jev({
    backoffInitialMs: 100,
    backoffMaxMs: 1000,
    backoffJitter: 0.5,
  });
  assertEquals(
    [0, 1, 2, 3, 4, 60].map((retry) => backoffDelay(small, retry, 0)),
    [100, 200, 400, 800, 1000, 1000],
  );
  assertEquals(backoffDelay(small, 1, 1), 100);
  const jittered = resolveRetryPolicy({
    backoffInitialMs: 1000,
    backoffJitter: 0.5,
  }, OPENAI);
  assertEquals(backoffDelay(jittered, 0, 1), 500);
});

Deno.test("retry-after: milliseconds, seconds and HTTP dates", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const at = (headers: Record<string, string>) =>
    parseRetryAfter(new Headers(headers), now);
  assertEquals(at({}), null);
  assertEquals(at({ "retry-after": "3" }), 3000);
  assertEquals(at({ "retry-after": "1.5" }), 1500);
  assertEquals(at({ "retry-after": "0" }), 0);
  assertEquals(at({ "retry-after-ms": "250.4" }), 251);
  assertEquals(at({ "retry-after-ms": "100", "retry-after": "9" }), 100);
  assertEquals(at({ "retry-after-ms": "soon", "retry-after": "2" }), 2000);
  assertEquals(at({ "retry-after": "Thu, 24 Sep 2026 12:00:07 GMT" }), 7000);
  assertEquals(at({ "retry-after": "Thu, 24 Sep 2026 11:59:00 GMT" }), 0);
  assertEquals(at({ "retry-after": "-5" }), null);
  assertEquals(at({ "retry-after": "whenever" }), null);
});
