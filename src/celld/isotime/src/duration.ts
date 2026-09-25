// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Strict ISO 8601 durations, `PnYnMnDTnHnMnS` and `PnW`, checked here and
 * handed to `Temporal.Duration` once they pass.
 *
 * @module
 */

const INT = "(\\d+)";
const NUMBER = "(\\d+(?:[.,]\\d+)?)";
const DURATION = new RegExp(
  `^P(?:${INT}W|(?:${INT}Y)?(?:${INT}M)?(?:${INT}D)?` +
    `(T(?:${NUMBER}H)?(?:${NUMBER}M)?(?:${NUMBER}S)?)?)$`,
);

/**
 * A duration as a `Temporal.Duration`, or null. It needs at least one
 * component, and a `T` needs at least one after it; weeks stand alone.
 * Only the last component may have a fraction, written with `.` or `,`,
 * and only hours, minutes or seconds (a fractional day, month or year has
 * no fixed length). Signs (ISO 8601-2's `-P1D`) are not accepted, and
 * neither is anything too large for `Temporal.Duration`. Digits past
 * nine in a fraction are cut off.
 */
export function parseDuration(text: string): Temporal.Duration | null {
  const match = DURATION.exec(text);
  if (match === null) return null;
  const [, w, y, mo, d, t, h, mi, s] = match;
  const written = [w, y, mo, d, h, mi, s].filter((part) => part !== undefined);
  if (written.length === 0) return null;
  if (
    t !== undefined && h === undefined && mi === undefined && s === undefined
  ) {
    return null;
  }
  if (written.slice(0, -1).some((part) => /[.,]/.test(part))) return null;
  try {
    return Temporal.Duration.from(
      text.replace(/[.,](\d{9})\d+/, ".$1"),
    );
  } catch {
    return null;
  }
}

/** Whether `text` is a duration; see {@link parseDuration}. */
export function isDuration(text: string): boolean {
  return parseDuration(text) !== null;
}
