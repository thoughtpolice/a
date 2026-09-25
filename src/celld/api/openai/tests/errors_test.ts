// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  apiErrorFromEvent,
  apiErrorFromResponse,
  DEFAULT_RETRY_POLICY,
  GptApiError,
  GptError,
  gptErrorFromData,
  GptInvalidRequestError,
  GptOutputError,
  isGptError,
  resolveGptRetryPolicy,
  retryDelayFromMessage,
  TRANSIENT_KINDS,
} from "@celld/api/openai";
import { backoffDelay } from "@celld/http";

function classify(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return apiErrorFromResponse(
    status,
    JSON.stringify(body),
    new Headers(headers),
    null,
  );
}

Deno.test("statuses map to kinds when no code decides", () => {
  const kinds = [400, 401, 403, 404, 429, 500, 502, 529, 418].map((status) =>
    classify(status, { error: { message: "x" } }).kind
  );
  assertEquals(kinds, [
    "bad_request",
    "authentication",
    "permission",
    "not_found",
    "rate_limited",
    "server",
    "server",
    "overloaded",
    "http",
  ]);
});

Deno.test("usage_limit_reached carries its reset time and plan", () => {
  const error = classify(429, {
    error: {
      type: "usage_limit_reached",
      message: "You've hit your usage limit.",
      plan_type: "pro",
      resets_at: 1_900_000_000,
    },
  });
  assertEquals([error.kind, error.code, error.resetsAt, error.retryable], [
    "usage_limit",
    "usage_limit_reached",
    1_900_000_000_000,
    false,
  ]);
  assert(error.message.includes("You've hit your usage limit."), error.message);
});

Deno.test("a usage limit without resets_at takes the active window's reset", () => {
  const error = classify(429, { error: { type: "usage_limit_reached" } }, {
    "x-codex-active-limit": "codex",
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1900000100",
    "x-codex-secondary-used-percent": "40",
    "x-codex-secondary-reset-at": "1900500000",
  });
  assertEquals(error.resetsAt, 1_900_000_100_000);
  assertEquals(error.rateLimits[0].primary?.usedPercent, 100);
});

Deno.test("quota and not-included codes are quota, never retried", () => {
  for (
    const body of [
      { error: { type: "usage_not_included" } },
      { error: { type: "insufficient_quota" } },
      { error: { code: "credit_balance_exhausted" } },
    ]
  ) {
    const error = classify(429, body);
    assertEquals([error.kind, error.retryable], ["quota", false]);
  }
});

Deno.test("503 bodies: server_is_overloaded and slow_down", () => {
  assertEquals(
    classify(503, { error: { code: "server_is_overloaded" } }).kind,
    "overloaded",
  );
  const slow = classify(503, {
    error: { code: "slow_down", message: "Please try again in 2.5s" },
  });
  assertEquals([slow.kind, slow.retryAfterMs], ["rate_limited", 2500]);
  assertEquals(
    classify(503, { error: { message: "upstream" } }).kind,
    "server",
  );
});

Deno.test("policy codes on 400 and 403, with Codex's fallback messages", () => {
  const cyber = classify(400, { error: { code: "cyber_policy", message: "" } });
  assertEquals([cyber.kind, cyber.code, cyber.retryable], [
    "policy",
    "cyber_policy",
    false,
  ]);
  assert(cyber.message.includes("possible cybersecurity risk"), cyber.message);
  assertEquals(
    classify(403, { error: { code: "misalignment_policy_violation" } }).kind,
    "policy",
  );
  assertEquals(
    classify(400, { error: { code: "context_length_exceeded" } }).kind,
    "context_window",
  );
  // A policy code on another status does not count.
  assertEquals(
    classify(500, { error: { code: "cyber_policy" } }).kind,
    "server",
  );
});

Deno.test("request ids come from x-request-id, then x-oai-request-id, then cf-ray", () => {
  assertEquals(
    classify(500, {}, { "x-request-id": "a", "cf-ray": "c" }).requestId,
    "a",
  );
  assertEquals(classify(500, {}, { "x-oai-request-id": "b" }).requestId, "b");
  assertEquals(classify(500, {}, { "cf-ray": "c" }).requestId, "c");
});

Deno.test("non-JSON bodies are kept as text, cut to 4 KiB", () => {
  const error = apiErrorFromResponse(
    502,
    "x".repeat(5000),
    new Headers(),
    null,
  );
  assertEquals((error.body as string).length, 4097);
  assertEquals(apiErrorFromResponse(500, "", new Headers(), null).body, null);
});

Deno.test("stream failures map codes; unknown ones are retryable server errors", () => {
  assertEquals(
    apiErrorFromEvent(
      { code: "context_length_exceeded", message: "too long" },
      "failed",
      null,
    ).kind,
    "context_window",
  );
  assertEquals(
    apiErrorFromEvent({ code: "insufficient_quota" }, "failed", null).kind,
    "quota",
  );
  assertEquals(
    apiErrorFromEvent({ code: "flex_unavailable" }, "failed", null).kind,
    "overloaded",
  );
  const limited = apiErrorFromEvent(
    { code: "rate_limit_exceeded", message: "Try again in 350ms." },
    "failed",
    "r1",
  );
  assertEquals([
    limited.kind,
    limited.retryAfterMs,
    limited.requestId,
    limited.status,
  ], ["rate_limited", 350, "r1", 200]);
  const other = apiErrorFromEvent(
    { code: "weird", message: "hmm" },
    "failed",
    null,
  );
  assertEquals([other.kind, other.retryable], ["server", true]);
  assertEquals(apiErrorFromEvent(undefined, "failed", null).kind, "server");
});

Deno.test("retry delays are read from messages in s, ms and seconds", () => {
  assertEquals(retryDelayFromMessage("try again in 1.5s"), 1500);
  assertEquals(retryDelayFromMessage("Try again in 20 seconds."), 20000);
  assertEquals(retryDelayFromMessage("try again in 250ms"), 250);
  assertEquals(retryDelayFromMessage("later"), null);
});

Deno.test("errors survive plain-data round trips with their class", () => {
  const original = classify(429, {
    error: { type: "usage_limit_reached", resets_at: 5 },
  });
  original.attempts = 3;
  const data = JSON.parse(JSON.stringify(original));
  assertEquals(data.kind, "usage_limit");
  const rebuilt = gptErrorFromData(data);
  assert(rebuilt instanceof GptApiError, "class rebuilt");
  assertEquals([rebuilt.message, rebuilt.attempts, rebuilt.resetsAt], [
    original.message,
    3,
    5000,
  ]);
  const invalid = gptErrorFromData(
    new GptInvalidRequestError([{ path: ["a"], message: "bad" }]).toJSON(),
  );
  assert(invalid instanceof GptInvalidRequestError, "invalid rebuilt");
  const refusal = gptErrorFromData(
    new GptOutputError("refusal", "no").toJSON(),
  );
  assertEquals([refusal instanceof GptOutputError, refusal.kind], [
    true,
    "refusal",
  ]);
  assert(isGptError(refusal) && refusal instanceof GptError, "is a GptError");
  assert(!isGptError(new Error("x")), "plain errors are not");
});

Deno.test("the retry policy checks its numbers", () => {
  assertEquals(DEFAULT_RETRY_POLICY.maxRetries, 4);
  assertEquals(DEFAULT_RETRY_POLICY.retryOn, TRANSIENT_KINDS);
  let message = "";
  try {
    resolveGptRetryPolicy({ backoffJitter: 2 });
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(
    message,
    "retry.backoffJitter must be a finite number from 0 to 1, got 2",
  );
  const policy = resolveGptRetryPolicy({
    backoffInitialMs: 100,
    backoffMaxMs: 1000,
    backoffJitter: 0,
  });
  assertEquals(
    [0, 1, 2, 3, 10].map((retry) => backoffDelay(policy, retry, 0.9)),
    [100, 200, 400, 800, 1000],
  );
  const jittered = resolveGptRetryPolicy({
    backoffInitialMs: 1000,
    backoffJitter: 0.5,
  });
  assertEquals(backoffDelay(jittered, 0, 1), 500);
});

Deno.test("the retried kinds may be any iterable, and undefined is the default", () => {
  const policy = resolveGptRetryPolicy({
    retryOn: new Set(["server", "server", "timeout"] as const),
    maxRetries: undefined,
  });
  assertEquals([policy.retryOn, policy.maxRetries], [["server", "timeout"], 4]);
  const narrowed = resolveGptRetryPolicy({ maxRetries: 1 }, policy);
  assertEquals([narrowed.retryOn, narrowed.maxRetries], [
    ["server", "timeout"],
    1,
  ]);
});
