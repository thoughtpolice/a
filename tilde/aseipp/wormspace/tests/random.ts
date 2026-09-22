// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A seeded generator for the layer model tests: mulberry32, as `model.ts`
 * uses, so a failing seed reproduces exactly on every platform.
 *
 * @module
 */

export class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** A float in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(this.#state ^ (this.#state >>> 15), 1 | this.#state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [0, bound). */
  int(bound: number): number {
    return Math.floor(this.next() * bound);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)];
  }

  /** Yields to other tasks a random number of times, to vary interleaving. */
  async yield(most = 3): Promise<void> {
    for (let turn = this.int(most + 1); turn > 0; turn -= 1) {
      await Promise.resolve();
    }
  }
}
