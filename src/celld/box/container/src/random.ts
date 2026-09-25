// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Unbiased random picks, for spreading load over interchangeable
 * instances (`getRandom`).
 *
 * @module
 */

/** The most instances `getRandom` and {@link uniformIndex} choose among. */
export const MAX_INSTANCES = 1024;

const RANGE = 2 ** 32;

/** A uniformly random 32-bit unsigned integer from the platform's CSPRNG. */
export function randomUint32(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/**
 * A uniformly random integer in `0..n-1`, for `n` from 1 to
 * {@link MAX_INSTANCES}. A 32-bit draw taken modulo `n` would favour the
 * low indexes whenever `n` does not divide 2^32, so draws at or above the
 * largest multiple of `n` are rejected and drawn again (rejection
 * sampling); fewer than one draw in a million is rejected at this size.
 *
 * A custom draw must return a uint32. At most 128 rejected draws are allowed;
 * a broken source cannot hang the caller.
 * @throws {RangeError} when `n` or a draw is out of range, or the source stalls.
 */
export function uniformIndex(
  n: number,
  draw: () => number = randomUint32,
): number {
  if (!Number.isInteger(n) || n < 1 || n > MAX_INSTANCES) {
    throw new RangeError(
      `the number of instances must be an integer from 1 to ${MAX_INSTANCES}, got ${n}`,
    );
  }
  const limit = RANGE - (RANGE % n);
  if (typeof draw !== "function") {
    throw new TypeError("draw must be a function");
  }
  for (let attempt = 0; attempt < 128; attempt++) {
    const value = draw();
    if (!Number.isInteger(value) || value < 0 || value >= RANGE) {
      throw new RangeError("draw must return a uint32");
    }
    if (value < limit) return value % n;
  }
  throw new RangeError("random source exceeded the rejection budget");
}
