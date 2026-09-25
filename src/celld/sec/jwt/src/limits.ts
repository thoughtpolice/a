// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Size limits for compact tokens, checked before anything is decoded.
 *
 * @module
 */

import { safeInt } from "@celld/core/bounds";

/**
 * Byte caps for a compact JWS. A token over any of them is refused with
 * `too_large` before its parts are decoded. `maxHeaderBytes` and
 * `maxPayloadBytes` count the decoded JSON; `maxTokenBytes` the whole
 * compact string.
 */
export interface JwtLimits {
  /** Default 8 KiB. */
  readonly maxTokenBytes?: number;
  /** Default 4 KiB. */
  readonly maxHeaderBytes?: number;
  /** Default 64 KiB (reachable only with a larger `maxTokenBytes`). */
  readonly maxPayloadBytes?: number;
}

/** The limits used when none are given. */
export const DEFAULT_JWT_LIMITS: Readonly<Required<JwtLimits>> = Object.freeze(
  {
    maxTokenBytes: 8 * 1024,
    maxHeaderBytes: 4 * 1024,
    maxPayloadBytes: 64 * 1024,
  },
);

/** The largest value any limit may be set to: 16 MiB. */
export const MAX_JWT_LIMIT = 16 * 1024 * 1024;

/** Checked limits with the defaults filled in. */
export type ResolvedLimits = Readonly<Required<JwtLimits>>;

/**
 * `limits` over the defaults, each a safe integer from 1 to
 * {@link MAX_JWT_LIMIT}; throws a `RangeError` otherwise.
 */
export function resolveLimits(limits: JwtLimits | undefined): ResolvedLimits {
  if (limits === undefined) return DEFAULT_JWT_LIMITS;
  if (typeof limits !== "object" || limits === null) {
    throw new TypeError("limits must be an object");
  }
  const one = (name: keyof JwtLimits) =>
    limits[name] === undefined ? DEFAULT_JWT_LIMITS[name] : safeInt(
      limits[name],
      { name: `limits.${name}`, min: 1, max: MAX_JWT_LIMIT },
    );
  return Object.freeze({
    maxTokenBytes: one("maxTokenBytes"),
    maxHeaderBytes: one("maxHeaderBytes"),
    maxPayloadBytes: one("maxPayloadBytes"),
  });
}
