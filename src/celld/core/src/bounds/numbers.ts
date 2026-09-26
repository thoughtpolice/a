// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Checked numbers and branded limits.
 *
 * @module
 */

import { BoundsError, describe } from "./error.ts";
import { checkName, strictRecord } from "./record.ts";

const NUMBER_KEYS = Object.freeze(["name", "min", "max"]);

/** How a number is checked: its name for messages, and an inclusive range. */
export interface NumberOptions {
  /** The option or field name, used in messages (`ttlMs`, `maxBytes`). */
  readonly name: string;
  /** The smallest value accepted (inclusive). */
  readonly min?: number;
  /** The largest value accepted (inclusive). */
  readonly max?: number;
}

/**
 * The longest delay a timer honours: `setTimeout` treats anything above
 * 2^31 - 1 ms (about 24.8 days) as 0 and fires at once.
 */
export const MAX_TIMER_MS = 2_147_483_647;

function number(value: unknown, name: string): number {
  if (typeof value !== "number") {
    throw new BoundsError(
      "type",
      `${name} must be a number, got ${describe(value)}`,
    );
  }
  if (!Number.isFinite(value)) {
    throw new BoundsError("range", `${name} must be finite, got ${value}`);
  }
  return value;
}

function inRange(value: number, options: NumberOptions): number {
  const { name, min, max } = options;
  if (min !== undefined && value < min) {
    throw new BoundsError(
      "range",
      `${name} must be at least ${min}, got ${value}`,
    );
  }
  if (max !== undefined && value > max) {
    throw new BoundsError(
      "range",
      `${name} must be at most ${max}, got ${value}`,
    );
  }
  return value;
}

function checkOptions(options: NumberOptions): void {
  strictRecord(options, NUMBER_KEYS, "number options");
  checkName(options.name);
  if (options.min !== undefined) number(options.min, `${options.name} min`);
  if (options.max !== undefined) number(options.max, `${options.name} max`);
  if (
    options.min !== undefined && options.max !== undefined &&
    options.min > options.max
  ) throw new BoundsError("range", `${options.name}: min must not exceed max`);
}

/**
 * `value` if it is a finite number within `min`..`max`.
 *
 * @throws {BoundsError} `type` for a non-number, `range` for `NaN`,
 * `±Infinity` or a value outside the range.
 */
export function finite(value: unknown, options: NumberOptions): number {
  checkOptions(options);
  return inRange(number(value, options.name), options);
}

/**
 * `value` if it is a safe integer (|n| ≤ 2^53 - 1) within `min`..`max`.
 *
 * @throws {BoundsError} as {@link finite}, and `range` for a fraction or an
 * unsafe integer.
 */
export function safeInt(value: unknown, options: NumberOptions): number {
  checkOptions(options);
  const checked = number(value, options.name);
  if (!Number.isSafeInteger(checked)) {
    throw new BoundsError(
      "range",
      `${options.name} must be a safe integer, got ${checked}`,
    );
  }
  return inRange(checked, options);
}

/**
 * `value` if it is a finite, non-negative duration in milliseconds no
 * longer than `max`, which defaults to (and may not exceed)
 * {@link MAX_TIMER_MS}. Fractions are accepted. `min` defaults to 0 and may
 * only raise it.
 *
 * @throws {BoundsError} as {@link finite}, and `range` for a negative or too
 * long duration.
 * @throws {RangeError} when `max` exceeds {@link MAX_TIMER_MS}.
 */
export function nonNegativeMs(value: unknown, options: NumberOptions): number {
  checkOptions(options);
  const max = options.max === undefined ? MAX_TIMER_MS : options.max;
  if (max < 0 || max > MAX_TIMER_MS) {
    throw new RangeError(
      `${options.name}: a max of ${max} ms is beyond a timer's range (${MAX_TIMER_MS})`,
    );
  }
  const min = options.min === undefined ? 0 : options.min;
  if (min < 0 || min > max) {
    throw new BoundsError(
      "range",
      `${options.name}: min must be within 0..max`,
    );
  }
  return inRange(number(value, options.name), { name: options.name, min, max });
}

declare const brand: unique symbol;

/** A number that has passed a check; `Kind` keeps different limits apart. */
export type Branded<Kind extends string> = number & {
  readonly [brand]: Kind;
};

/** A checked byte count: a non-negative safe integer. */
export type ByteLimit = Branded<"ByteLimit">;
/** A checked item or key count: a non-negative safe integer. */
export type CountLimit = Branded<"CountLimit">;
/** A checked nesting depth: a non-negative safe integer. */
export type DepthLimit = Branded<"DepthLimit">;
/** A checked duration: see {@link nonNegativeMs}. */
export type DurationMs = Branded<"DurationMs">;

/** Checks `n` as a byte limit. @throws {BoundsError} */
export function bytes(n: number, name = "bytes"): ByteLimit {
  return safeInt(n, { name, min: 0 }) as ByteLimit;
}

/** Checks `n` as a count limit. @throws {BoundsError} */
export function count(n: number, name = "count"): CountLimit {
  return safeInt(n, { name, min: 0 }) as CountLimit;
}

/** Checks `n` as a depth limit. @throws {BoundsError} */
export function depth(n: number, name = "depth"): DepthLimit {
  return safeInt(n, { name, min: 0 }) as DepthLimit;
}

/** Checks `n` as a duration in milliseconds. @throws {BoundsError} */
export function millis(n: number, name = "ms"): DurationMs {
  return nonNegativeMs(n, { name }) as DurationMs;
}
