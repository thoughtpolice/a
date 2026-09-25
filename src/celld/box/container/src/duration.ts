// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Durations for `sleepAfter` and the other timing settings.
 *
 * The unit rule of `@celld/box/container` and `@celld/box/sandbox`: a setting
 * whose name ends in `Ms` is a number of milliseconds; every other
 * duration is a {@link Duration}, a string that writes its unit. A bare
 * number is refused, because Cloudflare reads it as seconds and our `*Ms`
 * fields as milliseconds, and nothing at the call site says which.
 *
 * @module
 */

import { MAX_TIMER_MS, nonNegativeMs, strictRecord } from "@celld/core/bounds";

/**
 * A length of time as a string with its unit: a short form such as
 * `"500ms"`, `"30s"`, `"10m"`, `"2h"`, `"1d"` or `"1h30m"`, or an ISO 8601
 * duration such as `"PT10M"` (read with `Temporal.Duration`; years and
 * months have no fixed length and are refused). Numbers are not durations:
 * write `"90s"`, or use a `*Ms` field.
 */
export type Duration = string;

/** Limits for {@link durationMs}, checked on the converted value. */
export interface DurationLimits {
  /** The setting's name, for messages; default `"duration"`. */
  readonly name?: string;
  /** Inclusive, in ms; default 0. */
  readonly min?: number;
  /** Inclusive, in ms; default (and at most) a timer's range, about 24.8 days. */
  readonly max?: number;
}

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const SHORT = /^(\d{1,15}(?:\.\d{1,15})?)(ms|s|m|h|d)/;

function convert(duration: string, name: string): number {
  if (typeof duration !== "string") {
    throw new RangeError(
      `${name} must be a duration string with a unit (such as "90s" or "PT10M"), got ${typeof duration} ${
        String(duration)
      }; numbers are refused because their unit is ambiguous`,
    );
  }
  if (duration.trim() === "") {
    throw new RangeError(`${name} is empty`);
  }
  if (duration.startsWith("P")) {
    let total: number;
    try {
      total = Temporal.Duration.from(duration).total({ unit: "milliseconds" });
    } catch {
      throw new RangeError(
        `${name}: not a fixed-length ISO 8601 duration: ${
          duration.slice(0, 64)
        }`,
      );
    }
    return total;
  }
  let rest = duration;
  let total = 0;
  while (rest !== "") {
    const match = SHORT.exec(rest);
    if (match === null) {
      throw new RangeError(`${name}: not a duration: ${duration.slice(0, 64)}`);
    }
    total += Number(match[1]) * UNITS[match[2]];
    rest = rest.slice(match[0].length);
  }
  return total;
}

/**
 * A {@link Duration} in whole milliseconds, checked after conversion: the
 * result is finite, a safe integer, and within `min`..`max` (by default
 * 0 up to a timer's range, {@link MAX_TIMER_MS}).
 *
 * @throws {RangeError} for a number, an empty or whitespace-only string,
 * anything that is not a duration, and a result out of range.
 */
export function durationMs(
  duration: Duration,
  limits: DurationLimits = {},
): number {
  strictRecord(limits as unknown, ["name", "min", "max"], "duration limits");
  if (
    limits.name !== undefined &&
    (typeof limits.name !== "string" || limits.name.length > 256)
  ) {
    throw new TypeError("duration limit name must be a bounded string");
  }
  for (const value of [limits.min, limits.max]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(
        "duration bounds must be non-negative safe integers",
      );
    }
  }
  const name = limits.name ?? "duration";
  const ms = Math.round(convert(duration, name));
  if (!Number.isSafeInteger(ms)) {
    throw new RangeError(
      `${name} is too long: ${String(duration).slice(0, 64)}`,
    );
  }
  return nonNegativeMs(ms, {
    name,
    min: limits.min ?? 0,
    max: Math.min(limits.max ?? MAX_TIMER_MS, MAX_TIMER_MS),
  });
}
