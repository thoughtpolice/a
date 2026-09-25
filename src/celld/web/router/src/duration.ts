// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link Duration}: how long a cookie, a session or a request lasts, as
 * seconds or an ISO 8601 duration.
 *
 * @module
 */

import { BoundsError, finite } from "@celld/core/bounds";
import { RouterError } from "./errors.ts";

/**
 * A length of time: a number of seconds, or an ISO 8601 duration such as
 * `"PT8H"` or `"P30D"` (without years or months, which have no fixed
 * length).
 */
export type Duration = number | string;

function parse(text: string): Temporal.Duration | null {
  try {
    return Temporal.Duration.from(text);
  } catch {
    return null;
  }
}

/** What {@link durationMs} accepts. */
export interface DurationBounds {
  /** The largest result, in milliseconds; default `Number.MAX_SAFE_INTEGER`. */
  readonly maxMs?: number;
  /** How to name the maximum in the error; default the milliseconds. */
  readonly maxName?: string;
}

/**
 * `duration` in milliseconds: finite, not negative and at most
 * `bounds.maxMs`, checked on the converted value (so a huge number of
 * seconds cannot overflow into `Infinity` or past a timer's range).
 * Throws {@link RouterError} for a bad one.
 */
export function durationMs(
  duration: Duration,
  what: string,
  bounds: DurationBounds = {},
): number {
  const maxMs = bounds.maxMs ?? Number.MAX_SAFE_INTEGER;
  let ms: number;
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new RouterError(`${what} must be a non-negative number of seconds`);
    }
    ms = duration * 1000;
  } else {
    const parsed = typeof duration === "string" ? parse(duration) : null;
    if (
      parsed === null || parsed.sign < 0 || parsed.years !== 0 ||
      parsed.months !== 0
    ) {
      throw new RouterError(
        `${what} must be seconds or an ISO 8601 duration without years or months, got ${
          JSON.stringify(duration)
        }`,
      );
    }
    ms = (parsed.weeks * 7 + parsed.days) * 86_400_000 +
      parsed.hours * 3_600_000 +
      parsed.minutes * 60_000 + parsed.seconds * 1000 + parsed.milliseconds +
      parsed.microseconds / 1000 + parsed.nanoseconds / 1_000_000;
  }
  try {
    return finite(ms, { name: what, min: 0, max: maxMs });
  } catch (cause) {
    if (!(cause instanceof BoundsError)) throw cause;
    throw new RouterError(
      `${what} must be at most ${bounds.maxName ?? `${maxMs} ms`}`,
      { cause },
    );
  }
}
