// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Resource limits for code that takes numbers, bodies and documents from
 * outside, imported as "@celld/core/bounds".
 *
 * ```ts
 * import { bytes, nonNegativeMs, parseJsonBounded, readTextBounded } from "@celld/core/bounds";
 *
 * const ttl = nonNegativeMs(options.ttlMs ?? 60_000, { name: "ttlMs", max: 3_600_000 });
 * const text = await readTextBounded(response, { maxBytes: bytes(64 * 1024) });
 * const value: unknown = parseJsonBounded(text, { maxDepth: 16, maxKeys: 64, maxItems: 256 });
 * ```
 *
 * Rejected input values throw `BoundsError`, a `RangeError` with a `code`;
 * malformed option dictionaries throw `TypeError`. Checks
 * return what they were given, so they compose inline. The number checks
 * refuse `NaN`, infinities, non-numbers and (for integers) fractions and
 * unsafe integers; limits of the wrong type fail the same way.
 *
 * @module
 */

export { type BoundsCode, BoundsError } from "./error.ts";
export {
  type Branded,
  type ByteLimit,
  bytes,
  count,
  type CountLimit,
  depth,
  type DepthLimit,
  type DurationMs,
  finite,
  MAX_TIMER_MS,
  millis,
  nonNegativeMs,
  type NumberOptions,
  safeInt,
} from "./numbers.ts";
export {
  type BoundedBody,
  readBounded,
  type ReadOptions,
  readTextBounded,
  type ReadTextOptions,
} from "./read.ts";
export { type JsonLimits, MAX_JSON_DEPTH, parseJsonBounded } from "./json.ts";
export { jsonSnapshot, type SnapshotLimits } from "./objects.ts";
export { strictRecord } from "./record.ts";
export { opaqueIdentity } from "./identity.ts";
export {
  boundedList,
  boundedString,
  type StringBound,
  utf8Length,
} from "./collections.ts";
