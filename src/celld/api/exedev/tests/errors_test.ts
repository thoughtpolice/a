// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import { memoryNamespace } from "@celld/sec/ratelimit/testing";
import {
  backoffDelay,
  DEFAULT_RATE_LIMITS,
  DEFAULT_RETRY_POLICY,
  envLimiter,
  ExeAbortError,
  ExeApiError,
  ExeConnectionError,
  ExeDecodeError,
  ExeError,
  exeErrorFromData,
  ExeInvalidRequestError,
  exePolicies,
  ExeTimeoutError,
  isAmbiguousKind,
  isExeError,
  isTransient,
  kindForStatus,
  outcome,
  parseRetryAfter,
  resolveRetryPolicy,
} from "@celld/api/exedev";

Deno.test("statuses map to the kinds the HTTPS API page lists", () => {
  const cases: [number, string][] = [
    [400, "bad_request"],
    [401, "authentication"],
    [403, "permission"],
    [404, "not_found"],
    [405, "method_not_allowed"],
    [413, "too_large"],
    [422, "command_failed"],
    [429, "rate_limited"],
    [500, "server"],
    [502, "server"],
    [504, "command_timeout"],
    [418, "http"],
    [302, "http"],
  ];
  for (const [status, kind] of cases) {
    assertEquals(kindForStatus(status), kind, String(status));
  }
});

Deno.test("transient and ambiguous kinds", () => {
  for (
    const kind of [
      "rate_limited",
      "command_timeout",
      "server",
      "connection",
      "timeout",
    ] as const
  ) {
    assert(isTransient(kind), kind);
  }
  for (
    const kind of [
      "bad_request",
      "authentication",
      "permission",
      "command_failed",
      "decode",
      "invalid_request",
      "aborted",
    ] as const
  ) {
    assert(!isTransient(kind), kind);
  }
  for (
    const kind of [
      "connection",
      "timeout",
      "command_timeout",
      "server",
    ] as const
  ) assert(isAmbiguousKind(kind), kind);
  for (
    const kind of ["rate_limited", "command_failed", "authentication"] as const
  ) assert(!isAmbiguousKind(kind), kind);
});

Deno.test("errors round-trip through plain data", () => {
  const errors: ExeError[] = [
    new ExeApiError("command_failed", "exe.dev answered 422", {
      status: 422,
      body: { error: "no such VM" },
      detail: "no such VM",
      command: "rm web-9",
      attempts: 1,
    }),
    new ExeApiError("command_timeout", "slow", {
      status: 504,
      ambiguous: true,
      retryAfterMs: 5,
    }),
    new ExeInvalidRequestError([{ path: ["name"], message: "bad" }]),
    new ExeDecodeError(
      [{ path: ["vms", 0, "vm_name"], message: "is missing" }],
      { status: 200 },
    ),
    new ExeConnectionError("reset"),
    new ExeTimeoutError("late", { ambiguous: true }),
    new ExeAbortError(),
  ];
  for (const error of errors) {
    const data = JSON.parse(JSON.stringify(error));
    assertEquals(data, error.toJSON());
    const back = exeErrorFromData(structuredClone(data));
    assertEquals(back.toJSON(), error.toJSON());
    assertEquals(back.constructor, error.constructor);
    assert(isExeError(back), "isExeError");
  }
  assertEquals(new ExeConnectionError("x").ambiguous, true);
  assertEquals(
    new ExeConnectionError("x", { ambiguous: false }).ambiguous,
    false,
  );
  assertEquals(
    new ExeInvalidRequestError([{ path: [], message: "m" }]).message,
    "invalid request: (root): m",
  );
  assert(!isExeError(new Error("x")), "plain errors are not ExeErrors");
});

Deno.test("outcome returns values and ExeErrors as data, and rethrows bugs", async () => {
  assertEquals(await outcome(Promise.resolve(3)), { ok: true, value: 3 });
  const failed = await outcome(() =>
    Promise.reject(new ExeConnectionError("reset"))
  );
  assert(
    !failed.ok && failed.error.kind === "connection" && failed.error.retryable,
    JSON.stringify(failed),
  );
  try {
    await outcome(Promise.reject(new TypeError("bug")));
    throw new Error("swallowed");
  } catch (error) {
    assert(error instanceof TypeError, String(error));
  }
});

Deno.test("retry policy defaults, overrides and validation", () => {
  assertEquals(DEFAULT_RETRY_POLICY.statuses, [429, 500, 502, 503, 504]);
  const policy = resolveRetryPolicy({
    maxRetries: 5,
    statuses: new Set([503, 503, 429]),
  });
  assertEquals([policy.maxRetries, policy.statuses], [5, [429, 503]]);
  for (
    const bad of [
      { maxRetries: -1 },
      { maxRetries: 1.5 },
      { backoffJitter: 2 },
      { statuses: [99] },
      { budgetMs: 0 },
      { backoffInitialMs: Number.NaN },
    ]
  ) {
    try {
      resolveRetryPolicy(bad);
      throw new Error(`accepted ${JSON.stringify(bad)}`);
    } catch (error) {
      assert(error instanceof RangeError, String(error));
    }
  }
  assertEquals(resolveRetryPolicy({ budgetMs: null }).budgetMs, null);
});

Deno.test("backoff doubles, caps and jitters", () => {
  const policy = resolveRetryPolicy({
    backoffInitialMs: 100,
    backoffMaxMs: 1000,
    backoffJitter: 0.5,
  });
  assertEquals(
    [0, 1, 2, 3, 4, 60].map((retry) => backoffDelay(policy, retry, 0)),
    [100, 200, 400, 800, 1000, 1000],
  );
  assertEquals(backoffDelay(policy, 1, 1), 100);
  assertEquals(backoffDelay(resolveRetryPolicy({ backoffJitter: 1 }), 0, 1), 0);
});

Deno.test("retry-after as seconds, milliseconds and dates", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const read = (headers: Record<string, string>) =>
    parseRetryAfter(new Headers(headers), now);
  assertEquals(read({}), null);
  assertEquals(read({ "retry-after": "3" }), 3000);
  assertEquals(read({ "retry-after": "0.5" }), 500);
  assertEquals(read({ "retry-after-ms": "250", "retry-after": "9" }), 250);
  assertEquals(read({ "retry-after": "Thu, 01 Jan 2026 00:00:04 GMT" }), 4000);
  assertEquals(read({ "retry-after": "Wed, 31 Dec 2025 00:00:00 GMT" }), 0);
  assertEquals(read({ "retry-after": "-5" }), null);
  assertEquals(read({ "retry-after": "soon" }), null);
});

Deno.test("envLimiter paces by EXE_LIMITS over the RATE_LIMITS binding", () => {
  assertEquals(envLimiter({}), undefined);
  const limits = (env: { EXE_LIMITS?: string }) =>
    envLimiter({ RATE_LIMITS: memoryNamespace(), ...env })!.policies.map((
      policy,
    ) => [policy.name, policy.limit, policy.burst]);
  assertEquals(limits({}), [["requests", 5, 10]]);
  assertEquals(
    limits({ EXE_LIMITS: '{"requestsPerSecond": 2, "burst": 3}' }),
    [["requests", 2, 3]],
  );
  for (
    const [bad, message] of [
      ["{", "EXE_LIMITS must be JSON"],
      ['{"rps": 1}', '"rps"'],
      ["[]", "limits must be an object"],
    ]
  ) {
    try {
      limits({ EXE_LIMITS: bad });
      throw new Error("accepted");
    } catch (error) {
      assert(
        error instanceof TypeError && error.message.includes(message),
        String(error),
      );
    }
  }
});

Deno.test("the rate limit is a guess, as one requests policy", () => {
  assertEquals(DEFAULT_RATE_LIMITS, { requestsPerSecond: 5, burst: 10 });
  assertEquals(exePolicies(), [
    { name: "requests", limit: 5, window: 1, burst: 10 },
  ]);
  assertEquals(exePolicies({ burst: 1 })[0].burst, 1);
  for (
    const bad of [{ requestsPerSecond: 0 }, { burst: 0.5 }, {
      burst: Number.POSITIVE_INFINITY,
    }]
  ) {
    try {
      exePolicies(bad);
      throw new Error("accepted");
    } catch (error) {
      assert(error instanceof RangeError, String(error));
    }
  }
  try {
    exePolicies({ rps: 1 } as never);
    throw new Error("accepted");
  } catch (error) {
    assert(
      error instanceof TypeError && error.message.includes('"rps"'),
      String(error),
    );
  }
});
