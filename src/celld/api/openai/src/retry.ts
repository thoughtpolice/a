// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * When and how long to wait before trying a model call again.
 *
 * A request is sent again only when it is declared idempotent
 * ({@link requestIdempotency}) and the failure's kind is one the policy
 * retries ({@link mayRetryGpt}, which defers to `@celld/http`'s
 * `mayRetry`). A Responses call sent with `store: false` leaves nothing
 * behind on the server, so repeating one costs usage but has no other
 * effect; `GET /models` reads. Anything that would keep state on the
 * server (a stored response, a conversation, an upload) is not
 * idempotent, and is never sent twice once the server may have seen it.
 * The defaults follow Codex's
 * (`request_max_retries` of 4, exponential backoff, server `retry-after`
 * honoured) with a longer cap, because a subscription shared by several
 * agents is better served by waiting than by hammering. What is never
 * retried: usage limits (the wait is hours; the pacer handles it), quota,
 * policy refusals, context-window overflow, `response.incomplete`, bad
 * requests, auth failures, decode and output errors, and aborts.
 *
 * @module
 */

import {
  type HttpRetryPolicy,
  mayRetry,
  resolveRetryPolicy,
  type RetryFailure,
  type RetryOptions,
  type RetryPolicy,
  type RetryRequest,
} from "@celld/http";
import type { GptError, GptErrorKind } from "./errors.ts";
import type { JsonObject } from "./json.ts";

/**
 * `@celld/http`'s backoff, budget and `retry-after` handling, plus the
 * failure kinds to retry. The client takes any subset of it.
 */
export interface GptRetryPolicy extends RetryPolicy {
  /** The failure kinds retried. */
  readonly retryOn: readonly GptErrorKind[];
}

/** The transient kinds, retried by default. */
export const TRANSIENT_KINDS: readonly GptErrorKind[] = Object.freeze([
  "rate_limited",
  "overloaded",
  "server",
  "stream",
  "connection",
  "timeout",
]);

/**
 * The defaults. `budgetMs` is `null`, leaving only the per-attempt
 * timeouts, since a high-effort response can legitimately stream for many
 * minutes.
 */
export const DEFAULT_RETRY_POLICY: GptRetryPolicy = Object.freeze({
  maxRetries: 4,
  backoffInitialMs: 500,
  backoffMaxMs: 20_000,
  backoffJitter: 0.2,
  retryOn: TRANSIENT_KINDS,
  respectRetryAfter: true,
  maxRetryAfterMs: 120_000,
  budgetMs: null,
});

/** A partial policy, as the client accepts it; `retryOn` may be any iterable. */
export type GptRetryOptions = RetryOptions<GptRetryPolicy>;

/**
 * Fills a partial policy from `base` (default {@link DEFAULT_RETRY_POLICY})
 * and checks every field, as `@celld/http`'s `resolveRetryPolicy` does.
 *
 * @throws {RangeError} naming the first bad field.
 */
export function resolveGptRetryPolicy(
  options: GptRetryOptions = {},
  base: GptRetryPolicy = DEFAULT_RETRY_POLICY,
): GptRetryPolicy {
  return resolveRetryPolicy(options, base);
}

/**
 * The requests the client sends: `responses` is `POST /responses`,
 * `models.list` is `GET /models`.
 */
export type GptRequestKind = "responses" | "models.list";

/**
 * Whether a request of `kind` may be sent again after the server may have
 * acted on it. `responses` is idempotent only when `body.store` is exactly
 * `false`: the backend then keeps nothing (the request builder always sets
 * it, and refuses a `store` field). A body without it, or with `store:
 * true`, would leave a stored response behind, so it is not. `models.list`
 * is a GET.
 *
 * @throws {TypeError} an unknown kind: a new kind of request must be
 * declared here before the client may retry it.
 */
export function requestIdempotency(
  kind: GptRequestKind,
  body?: JsonObject,
): boolean {
  switch (kind) {
    case "responses":
      return body?.store === false;
    case "models.list":
      return true;
    default:
      throw new TypeError(
        `no idempotency is declared for ${JSON.stringify(kind)} requests`,
      );
  }
}

// How a failure of this client looks to `mayRetry`: whether the server may
// have acted on the request. `null` for kinds that are never retried.
function retryFailure(failure: GptError): RetryFailure | null {
  switch (failure.kind) {
    case "aborted":
    case "invalid_request":
      return null;
    case "connection":
      return { kind: "connection" };
    case "timeout":
      return { kind: "timeout" };
    case "stream":
    case "decode":
    case "output":
    case "refusal":
      return { kind: "body" };
    default:
      return { kind: "status", status: failure.status ?? 0 };
  }
}

/**
 * Whether `failure` may be retried under `policy` for `request`, before
 * counting attempts or the budget: its kind must be in `retryOn`, and
 * `@celld/http`'s `mayRetry` must allow it for the declared idempotency.
 * A connection failure is not retried for a request that is not
 * idempotent either (`mayRetry` would): a rejected `fetch` does not prove
 * the server never saw the request. An abort is never retried.
 *
 * @throws {TypeError} `request.idempotent` is not declared as a boolean.
 */
export function mayRetryGpt(
  policy: GptRetryPolicy,
  failure: GptError,
  request: RetryRequest,
): boolean {
  if (typeof request?.idempotent !== "boolean") {
    throw new TypeError(
      "mayRetryGpt needs request.idempotent declared as true or false",
    );
  }
  if (!request.idempotent || !policy.retryOn.includes(failure.kind)) {
    return false;
  }
  const kind = retryFailure(failure);
  if (kind === null) return false;
  // `retryOn` has already chosen the kind; the view lets `mayRetry` apply
  // the idempotency rule and `maxRetries`.
  const view: HttpRetryPolicy = {
    ...policy,
    statuses: kind.kind === "status" ? [kind.status] : [],
    retryConnectionErrors: true,
    retryTimeouts: true,
  };
  return mayRetry(view, kind, request);
}
