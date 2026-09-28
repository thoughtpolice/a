// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The `RateLimit-Policy` and `RateLimit` response fields of
 * [draft-ietf-httpapi-ratelimit-headers-11](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/),
 * and `Retry-After`.
 *
 * Both fields are Structured Field lists with one item per policy, named
 * by the policy's name (which is always a valid sf-string): the policy
 * says its quota `q` per window `w` (seconds), the limit says the units
 * `r` left and the seconds `t` until they are back to the burst. A
 * policy's burst is not in the draft's vocabulary, so `q` is its `limit`.
 * The partition key (`pk`) is left out: it would tell the client how its
 * requests are grouped.
 *
 * @module
 */

import type { PolicyStatus } from "./gcra.ts";

function seconds(ms: number): number {
  return Math.ceil(ms / 1000);
}

/** `RateLimit-Policy`: `"burst";q=100;w=60, "daily";q=1000;w=86400`. */
export function policyField(statuses: readonly PolicyStatus[]): string {
  return statuses.map((status) =>
    `"${status.name}";q=${status.limit};w=${
      Math.max(1, seconds(status.windowMs))
    }`
  ).join(", ");
}

/** `RateLimit`: `"burst";r=50;t=30, "daily";r=990;t=41`. */
export function limitField(statuses: readonly PolicyStatus[]): string {
  return statuses.map((status) =>
    `"${status.name}";r=${status.remaining};t=${seconds(status.resetMs)}`
  ).join(", ");
}

/** `Retry-After` in whole seconds, at least 1, for a wait in milliseconds. */
export function retryAfterField(ms: number): string {
  return String(Math.max(1, seconds(ms)));
}
