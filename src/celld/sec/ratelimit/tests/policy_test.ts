// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "@celld/core/assert";
import {
  durationMs,
  MAX_KEY_BYTES,
  resolvePolicies,
  resolvePolicy,
} from "@celld/sec/ratelimit";

Deno.test("policies: burst defaults to the limit, windows in seconds or ISO 8601", () => {
  assertEquals(resolvePolicy({ name: "api", limit: 100, window: 60 }), {
    name: "api",
    limit: 100,
    windowMs: 60_000,
    burst: 100,
  });
  assertEquals(
    resolvePolicy({ name: "login", limit: 5, window: "PT15M", burst: 3 }),
    { name: "login", limit: 5, windowMs: 900_000, burst: 3 },
  );
  assertEquals(durationMs("P1W", "w"), 7 * 86_400_000);
  assertEquals(durationMs("PT0.25S", "w"), 250);
  assertEquals(durationMs(0.5, "w"), 500);
});

Deno.test("policies: every bad field is refused with its name", () => {
  const cases: [unknown, RegExp][] = [
    [{ name: "API", limit: 1, window: 1 }, /policy name/],
    [{ name: "a".repeat(65), limit: 1, window: 1 }, /policy name/],
    [{ name: "x", limit: 0, window: 1 }, /x: limit/],
    [{ name: "x", limit: 1.5, window: 1 }, /x: limit/],
    [{ name: "x", limit: 1, window: 1, burst: 0 }, /x: burst/],
    [{ name: "x", limit: 2e9, window: 1 }, /x: limit/],
    [{ name: "x", limit: 1, window: -1 }, /x: window/],
    [{ name: "x", limit: 1, window: "P1M" }, /years or months/],
    [{ name: "x", limit: 1, window: "soon" }, /ISO 8601/],
    [{ name: "x", limit: 1, window: 0.0005 }, /1 ms to 400 days/],
    [{ name: "x", limit: 1, window: "P401D" }, /1 ms to 400 days/],
    [{ name: "x", limit: 2_000_000, window: 1 }, /million units/],
    [{ name: "x", limit: 1, window: 1, per: "ip" }, /no option "per"/],
    [null, /an object/],
  ];
  for (const [policy, message] of cases) {
    let error: unknown;
    try {
      resolvePolicy(policy as never);
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof Error) || !message.test(error.message)) {
      throw new Error(
        `expected ${message} for ${JSON.stringify(policy)}, got ${error}`,
      );
    }
  }
});

Deno.test("policies: a limiter has one to eight, with distinct names", () => {
  const policy = { name: "a", limit: 1, window: 1 };
  assertThrows(() => resolvePolicies([]), RangeError, "1 to 8");
  assertThrows(
    () =>
      resolvePolicies(
        Array.from({ length: 9 }, (_, i) => ({ ...policy, name: `p${i}` })),
      ),
    RangeError,
    "1 to 8",
  );
  assertThrows(
    () => resolvePolicies([policy, { ...policy, limit: 2 }]),
    TypeError,
    "two policies are named a",
  );
  const resolved = resolvePolicies([policy]);
  assertEquals(Object.isFrozen(resolved), true);
  assertEquals(Object.isFrozen(resolved[0]), true);
});

Deno.test("policies: resolved policies are checked again, as a shard does", () => {
  const resolved = resolvePolicies([{ name: "a", limit: 3, window: "PT1M" }]);
  assertEquals(resolvePolicies(resolved), resolved);
  assertThrows(
    () =>
      resolvePolicies([
        { name: "a", limit: 3, windowMs: 0, burst: 3 } as never,
      ]),
    RangeError,
    "window",
  );
  assertThrows(
    () =>
      resolvePolicies([
        { name: "a", limit: 3, windowMs: 1000, burst: 3, extra: 1 } as never,
      ]),
    TypeError,
    'no option "extra"',
  );
  assertThrows(
    () =>
      resolvePolicies([
        { name: "a", limit: 3, windowMs: "1000", burst: 3 } as never,
      ]),
    RangeError,
    "window",
  );
});

Deno.test("policies: the key bound is on UTF-8 bytes", async () => {
  const { memoryLimiter } = await import("@celld/sec/ratelimit");
  const limiter = memoryLimiter({
    policies: [{ name: "a", limit: 1, window: 1 }],
  });
  await limiter.limit("é".repeat(MAX_KEY_BYTES / 2));
  let error: unknown;
  try {
    await limiter.limit("é".repeat(MAX_KEY_BYTES / 2 + 1));
  } catch (caught) {
    error = caught;
  }
  assertEquals(error instanceof RangeError, true);
});
