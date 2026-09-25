// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Durations for `sleepAfter` and the other timing settings.
 *
 * @module
 */

/**
 * A length of time: a number of **seconds** (as Cloudflare's `sleepAfter`
 * takes it), a short form such as `"500ms"`, `"30s"`, `"10m"`, `"2h"` or
 * `"1h30m"`, or an ISO 8601 duration such as `"PT10M"` (read with
 * `Temporal.Duration`; years and months have no fixed length and are
 * refused).
 */
export type Duration = number | string;

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const SHORT = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)/;

/** A {@link Duration} in milliseconds; throws a `RangeError` for anything else. */
export function durationMs(duration: Duration): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new RangeError(
        `a duration in seconds must be finite and non-negative, got ${duration}`,
      );
    }
    return Math.round(duration * 1_000);
  }
  if (typeof duration !== "string" || duration === "") {
    throw new RangeError(`not a duration: ${String(duration)}`);
  }
  if (duration.startsWith("P")) {
    try {
      return Math.round(
        Temporal.Duration.from(duration).total({ unit: "milliseconds" }),
      );
    } catch {
      throw new RangeError(`not a fixed-length ISO 8601 duration: ${duration}`);
    }
  }
  let rest = duration.trim();
  let total = 0;
  if (/^\d+(?:\.\d+)?$/.test(rest)) return durationMs(Number(rest));
  while (rest !== "") {
    const match = SHORT.exec(rest);
    if (match === null) throw new RangeError(`not a duration: ${duration}`);
    total += Number(match[1]) * UNITS[match[2]];
    rest = rest.slice(match[0].length);
  }
  return Math.round(total);
}
