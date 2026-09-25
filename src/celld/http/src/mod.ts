// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared pieces of the celld HTTP clients: retry policies, an injectable
 * runtime and `fetch`, and error-body truncation. Policy-bound outbound
 * fetches are in `@celld/http/egress`, server-sent events in
 * `@celld/http/sse` and test doubles in `@celld/http/testing`.
 *
 * @module
 */

export { type JsonValue, MAX_ERROR_TEXT, truncatedBody } from "./body.ts";
export {
  backoffDelay,
  type HttpRetryPolicy,
  isIdempotentMethod,
  MAX_RETRIES,
  mayRetry,
  parseRetryAfter,
  resolveRetryPolicy,
  type RetryFailure,
  type RetryOptions,
  type RetryPolicy,
  type RetryRequest,
} from "./retry.ts";
export {
  defaultRuntime,
  type FetchLike,
  globalFetch,
  rejectOnAbort,
  type Runtime,
} from "./runtime.ts";
