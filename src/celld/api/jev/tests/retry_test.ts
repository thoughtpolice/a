// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import {
  backoffDelay,
  DEFAULT_RETRY_POLICY,
  parseRetryAfter,
  resolveRetryPolicy,
} from "@celld/api/jev";

Deno.test("defaults are the SDKs', less 408", () => {
  const policy = DEFAULT_RETRY_POLICY;
  assertEquals(
    [
      policy.maxRetries,
      policy.backoffInitialMs,
      policy.backoffMaxMs,
      policy.backoffJitter,
      policy.maxRetryAfterMs,
      policy.budgetMs,
    ],
    [2, 500, 5000, 0.25, 60000, 30000],
  );
  assert(policy.statuses.includes(429), "429");
  assert(policy.statuses.includes(529), "529");
  assert(policy.statuses.includes(500) && policy.statuses.includes(599), "5xx");
  assert(!policy.statuses.includes(408), "never 408 by default");
  assertEquals(policy.statuses.filter((status) => status < 500), [429]);
});

Deno.test("partial policies fill from the base and are checked", () => {
  const policy = resolveRetryPolicy({
    maxRetries: 5,
    statuses: new Set([503, 429, 503]),
  });
  assertEquals(policy.maxRetries, 5);
  assertEquals(policy.statuses, [429, 503]);
  assertEquals(policy.backoffInitialMs, 500);
  assertEquals(
    assertThrows(() => resolveRetryPolicy({ backoffJitter: 2 })).message,
    "retry.backoffJitter must be a finite number from 0 to 1, got 2",
  );
  assertEquals(
    assertThrows(() => resolveRetryPolicy({ maxRetries: 1.5 })).message,
    "retry.maxRetries must be a non-negative integer, got 1.5",
  );
  assertEquals(
    assertThrows(() => resolveRetryPolicy({ statuses: [42] })).message,
    "retry.statuses has a non-status 42",
  );
  assertEquals(resolveRetryPolicy({ budgetMs: null }).budgetMs, null);
});

Deno.test("backoff doubles to the cap, less jitter", () => {
  const exact = resolveRetryPolicy({ backoffJitter: 0 });
  assertEquals(
    [0, 1, 2, 3, 4, 100].map((retry) => backoffDelay(exact, retry, 0.9)),
    [500, 1000, 2000, 4000, 5000, 5000],
  );
  const policy = DEFAULT_RETRY_POLICY;
  assertEquals(backoffDelay(policy, 0, 0), 500);
  assertEquals(backoffDelay(policy, 0, 1), 375);
  const full = resolveRetryPolicy({ backoffJitter: 1 });
  assertEquals(backoffDelay(full, 1, 0.5), 500);
  assertEquals(backoffDelay(full, 1, 0.999), 1);
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
