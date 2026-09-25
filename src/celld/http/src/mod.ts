// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared pieces of the celld HTTP clients: retry policies, an injectable
 * runtime and `fetch`, and error-body truncation. Server-sent events are in
 * `@celld/http/sse` and test doubles in `@celld/http/testing`.
 *
 * @module
 */

export { type JsonValue, MAX_ERROR_TEXT, truncatedBody } from "./body.ts";
export {
  backoffDelay,
  type HttpRetryPolicy,
  parseRetryAfter,
  resolveRetryPolicy,
  type RetryOptions,
  type RetryPolicy,
} from "./retry.ts";
export {
  defaultRuntime,
  type FetchLike,
  globalFetch,
  rejectOnAbort,
  type Runtime,
} from "./runtime.ts";
