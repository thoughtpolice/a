// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Probability-vector operations for the pure FACF search engine.
 *
 * A vector has one slot per suspect, oldest to newest, followed by a final
 * "no culprit" hypothesis. This ports `facf/distribution.rs` from revision
 * `zrqw` (commit `f28b0530f45979e1eed4be25c9a694fef98cbcbf`). Unlike the Rust
 * mutable-slice accessor, this module only exposes copies, so readers cannot
 * silently corrupt the search state. Inputs additionally reject non-finite
 * values. No celld, repository, or execution-platform concepts live here.
 *
 * @module
 */

/** A finite, nonnegative vector over suspects plus the no-culprit hypothesis. */
export class Distribution {
  /** Private vector; callers obtain defensive copies through `probs`. */
  readonly #probs: number[];

  /** Constructs a validated vector; normalization is explicit. */
  private constructor(probs: readonly number[]) {
    if (probs.length < 2) {
      throw new RangeError("need at least 1 suspect + no-culprit");
    }
    if (
      !probs.every((probability) =>
        Number.isFinite(probability) && probability >= 0
      )
    ) {
      throw new RangeError("all probabilities must be finite and non-negative");
    }
    this.#probs = [...probs];
  }

  /** Gives each suspect and no-culprit equal prior probability. */
  static uniform(numSuspects: number): Distribution {
    if (!Number.isSafeInteger(numSuspects) || numSuspects < 1) {
      throw new RangeError("must have at least one suspect (a safe integer)");
    }
    return new Distribution(Array(numSuspects + 1).fill(1 / (numSuspects + 1)));
  }

  /** Copies raw weights, which need not sum to one until `normalize` is called. */
  static fromProbs(probs: readonly number[]): Distribution {
    return new Distribution(probs);
  }

  /** Number of ordered suspect slots, excluding no-culprit. */
  get numSuspects(): number {
    return this.#probs.length - 1;
  }

  /** Returns an independent copy of the complete vector. */
  get probs(): number[] {
    return [...this.#probs];
  }

  /** Reads a suspect probability, or no-culprit at index `numSuspects`. */
  get(index: number): number {
    if (
      !Number.isSafeInteger(index) || index < 0 || index >= this.#probs.length
    ) {
      throw new RangeError("distribution index out of range");
    }
    return this.#probs[index];
  }

  /** Returns the last maximum, matching Rust Iterator::max_by tie-breaking. */
  argmax(): number {
    let winner = 0;
    for (let index = 1; index < this.#probs.length; index++) {
      if (this.#probs[index] >= this.#probs[winner]) winner = index;
    }
    return winner;
  }

  /** Returns the probability of the winning hypothesis. */
  max(): number {
    return this.#probs[this.argmax()];
  }

  /** Returns inclusive cumulative probability, including the no-culprit slot. */
  cdf(): number[] {
    let sum = 0;
    return this.#probs.map((probability) => sum += probability);
  }

  /** Tests normalization using the Rust implementation's absolute tolerance. */
  isNormalized(): boolean {
    return Math.abs(
      this.#probs.reduce((sum, probability) => sum + probability, 0) - 1,
    ) < 1e-9;
  }

  /**
   * Normalizes positive weights in place; all-zero weights remain all zero.
   * Scaling by the largest weight first avoids overflow for large finite inputs.
   */
  normalize(): void {
    const maximum = this.max();
    if (maximum === 0) return;
    const total = this.#probs.reduce(
      (sum, probability) => sum + probability / maximum,
      0,
    );
    for (let index = 0; index < this.#probs.length; index++) {
      this.#probs[index] = (this.#probs[index] / maximum) / total;
    }
  }
}
