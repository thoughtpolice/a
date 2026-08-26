// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Flake-aware, Bayesian culprit finding independent of scheduling or storage.
 *
 * This is a port of `src/qq/qq-cli/commands/hunt/facf/search.rs` at JJ revision
 * `zrqw` (commit `f28b0530f45979e1eed4be25c9a694fef98cbcbf`), which implements
 * the asymmetric noise model and selection heuristic described in Henderson
 * et al., "Flake Aware Culprit Finding". The Rust defaults, Equation 13
 * weighting, prefer-prior heuristic, inclusive threshold, and last-index
 * tie-breaking are preserved. This is a port of that implementation, not a
 * claim that it implements every part of TAP or every variant in the paper.
 *
 * Intentional differences: camelCase APIs; finite/integer input checks;
 * defensive snapshots; an observable false return for impossible evidence;
 * and log-space Bayesian updates. Log-space arithmetic preserves hypotheses
 * across long failure streaks that would underflow to zero in the Rust code.
 * Impossible observations are still recorded without changing the posterior,
 * matching the Rust behavior. A caller must surface that model inconsistency.
 *
 * ASSUMPTION: a real regression never passes at or after its introducing
 * commit. Random failures occur independently before that commit at a fixed
 * `flakeRate`. This is not a general model for arbitrary intermittent bugs,
 * multiple fixes/regressions, correlated outages, or infrastructure failures.
 * Feed it actual pass/fail test executions over one unchanged test lineage;
 * do not feed skipped/unknown/infra outcomes or inherited coverage as evidence.
 *
 * @module
 */

import { Distribution } from "./distribution.ts";

/** A genuine test execution outcome; infrastructure failures are not evidence. */
export type TestResult = "pass" | "fail";

/** A single independent execution at an ordered, zero-based suspect position. */
export interface Execution {
  /** Index in the caller's oldest-to-newest commit sequence. */
  readonly position: number;
  /** Observed pass or fail, not an inferred/inherited result. */
  readonly result: TestResult;
}

/** Tunable noise model, termination confidence, and next-position heuristic. */
export interface SearchConfig {
  /** Probability of failure without a real regression, in [0, 1]. */
  readonly flakeRate: number;
  /** Minimum posterior confidence required to report a result, in [0, 1]. */
  readonly threshold: number;
  /** Whether to use the Rust implementation's Equation 13 selection weights. */
  readonly useInfoGainWeighting: boolean;
}

/** The Rust implementation's defaults; callers should calibrate the noise rate. */
export const DEFAULT_SEARCH_CONFIG: Readonly<SearchConfig> = Object.freeze({
  flakeRate: 0.01,
  threshold: 0.9,
  useInfoGainWeighting: true,
});

/** Rust's deterministic, bisect-like configuration (no false test failures). */
export const DETERMINISTIC_SEARCH_CONFIG: Readonly<SearchConfig> = Object
  .freeze({
    flakeRate: 0,
    threshold: 0.99,
    useInfoGainWeighting: false,
  });

/** A threshold-qualified conclusion, conditional on the configured noise model. */
export type SearchResult =
  | {
    /** Identifies a suspect commit as the likely regression. */
    readonly kind: "culprit";
    /** Zero-based index in the caller's ordered commit sequence. */
    readonly position: number;
    /** Posterior probability of this hypothesis, not an absolute guarantee. */
    readonly confidence: number;
  }
  | {
    /** The original failure was likely a flake, not a suspect regression. */
    readonly kind: "no_culprit";
    /** Posterior probability that none of the suspects introduced a regression. */
    readonly confidence: number;
  };

/**
 * Caller-driven FACF state machine (the Rust `State` type).
 *
 * Durable orchestrators can rebuild this state from a frozen prior/config and
 * an execution ledger. Replay each independent execution exactly once: a
 * redelivered queue message is not an additional test result. Execution order
 * does not affect consistent evidence except for floating-point rounding.
 */
export class FacfSearch {
  /** Immutable noise and selection settings for the entire search. */
  readonly #config: Readonly<SearchConfig>;
  /** Number of suspects, excluding the final no-culprit hypothesis. */
  readonly #numSuspects: number;
  /** Normalized log posterior; negative infinity represents eliminated hypotheses. */
  #logProbabilities: number[];
  /** Audit ledger, including impossible observations whose update was ignored. */
  readonly #executions: Execution[] = [];

  /** Creates a uniform prior over `numSuspects` commits plus no-culprit. */
  constructor(numSuspects: number, config: Partial<SearchConfig> = {}) {
    const prior = Distribution.uniform(numSuspects);
    const resolved = { ...DEFAULT_SEARCH_CONFIG, ...config };
    if (
      !Number.isFinite(resolved.flakeRate) || resolved.flakeRate < 0 ||
      resolved.flakeRate > 1
    ) {
      throw new RangeError("flakeRate must be in [0, 1]");
    }
    if (
      !Number.isFinite(resolved.threshold) || resolved.threshold < 0 ||
      resolved.threshold > 1
    ) {
      throw new RangeError("threshold must be in [0, 1]");
    }
    if (typeof resolved.useInfoGainWeighting !== "boolean") {
      throw new TypeError("useInfoGainWeighting must be a boolean");
    }
    this.#config = Object.freeze(resolved);
    this.#numSuspects = numSuspects;
    this.#logProbabilities = prior.probs.map(Math.log);
  }

  /**
   * Creates a search from an already-normalized prior, including no-culprit.
   * Zero prior probability permanently excludes a hypothesis; choose carefully.
   */
  static withPrior(
    prior: readonly number[],
    config: Partial<SearchConfig> = {},
  ): FacfSearch {
    const distribution = Distribution.fromProbs(prior);
    if (!distribution.isNormalized()) {
      throw new RangeError(
        "prior must be normalized (probabilities must sum to 1.0)",
      );
    }
    const state = new FacfSearch(distribution.numSuspects, config);
    state.#logProbabilities = distribution.probs.map(Math.log);
    return state;
  }

  /** A defensive posterior snapshot, with no-culprit in the final slot. */
  get probabilities(): number[] {
    const snapshot = Distribution.fromProbs(
      this.#logProbabilities.map(Math.exp),
    );
    snapshot.normalize();
    return snapshot.probs;
  }

  /** A defensive distribution snapshot for CDF, maximum, and normalization queries. */
  get distribution(): Distribution {
    return Distribution.fromProbs(this.probabilities);
  }

  /** All observations in arrival order, returned as independent records. */
  get executions(): Execution[] {
    return this.#executions.map((execution) => ({ ...execution }));
  }

  /** Number of submitted observations, including zero-likelihood observations. */
  get iterations(): number {
    return this.#executions.length;
  }

  /** Number of concrete commits in the search range. */
  get numSuspects(): number {
    return this.#numSuspects;
  }

  /** Frozen settings used by every Bayesian update and selection. */
  get config(): Readonly<SearchConfig> {
    return this.#config;
  }

  /**
   * Selects up to `k` distinct next positions (Rust Algorithm 3 port).
   *
   * Uniform thresholds `i/(k+1)` cross the selection CDF. The prefer-prior
   * heuristic tests the preceding position when it has positive posterior
   * cumulative mass and is not already selected. It can repeat a position
   * across calls, and it does not know about in-flight work.
   *
   * As in Rust, this method can return [] before reaching the confidence
   * threshold, particularly with a dominant no-culprit prior and unweighted
   * selection. The caller must mark the search inconclusive or explicitly
   * schedule a useful probe (often the newest suspect); never call [] success.
   * It also does not stop automatically after `result()` becomes non-null.
   */
  nextRuns(k: number): number[] {
    if (!Number.isSafeInteger(k) || k < 0) {
      throw new RangeError("k must be a non-negative safe integer");
    }
    if (k === 0) return [];
    const posteriorCdf = this.distribution.cdf();
    const selectionCdf =
      this.#config.useInfoGainWeighting && this.#config.flakeRate > 0
        ? this.computeInfoGainWeightedCdf() ??
          posteriorCdf.slice(0, this.#numSuspects)
        : posteriorCdf.slice(0, this.#numSuspects);
    const runs: number[] = [];
    let thresholdIndex = 1;
    for (
      let candidate = 0;
      candidate < this.#numSuspects && thresholdIndex <= k;
      candidate++
    ) {
      while (
        thresholdIndex <= k &&
        selectionCdf[candidate] >= thresholdIndex / (k + 1)
      ) {
        const selected = candidate > 0 && !runs.includes(candidate - 1) &&
            posteriorCdf[candidate - 1] > 0
          ? candidate - 1
          : candidate;
        if (!runs.includes(selected)) runs.push(selected);
        thresholdIndex++;
      }
    }
    return runs;
  }

  /**
   * Builds the Rust implementation's Equation 13 selection CDF.
   *
   * Each suspect has weight `(1-f) * (n + (i+1)*f - 1) * posterior[i]`.
   * No-culprit is excluded. Returns null if all weights vanish, including
   * the f=1 boundary. This is the source's heuristic, not an entropy solver.
   */
  computeInfoGainWeightedCdf(): number[] | null {
    const n = this.#numSuspects;
    const f = this.#config.flakeRate;
    const posterior = this.probabilities;
    const weighted = posterior.slice(0, n).map((probability, index) =>
      (1 - f) * (n + (index + 1) * f - 1) * probability
    );
    const total = weighted.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) return null;
    let sum = 0;
    return weighted.map((weight) => sum += weight / total);
  }

  /**
   * Records one independent observation and applies Equations 8–12 in log space.
   *
   * Returns false only when the observation has zero likelihood under every
   * surviving hypothesis (e.g. any PASS when f=1, or contradictory outcomes
   * when f=0). The evidence stays in the ledger but the posterior is unchanged,
   * matching Rust. Callers should report an inconclusive/model-mismatch outcome
   * instead of trusting a previously confident conclusion in that situation.
   */
  recordResult(position: number, result: TestResult): boolean {
    if (
      !Number.isSafeInteger(position) || position < 0 ||
      position >= this.#numSuspects
    ) {
      throw new RangeError("position out of range");
    }
    if (result !== "pass" && result !== "fail") {
      throw new TypeError("result must be pass or fail");
    }
    this.#executions.push({ position, result });
    const f = this.#config.flakeRate;
    const updated = this.#logProbabilities.map((probability, index) => {
      const likelihood = result === "pass"
        ? (index > position ? Math.log1p(-f) : -Infinity)
        : (index > position ? Math.log(f) : 0);
      return probability + likelihood;
    });
    // Subtracting the maximum before exp prevents overflow and retains tiny
    // nonzero hypotheses internally even when the public snapshot underflows.
    const maximum = updated.reduce(
      (best, probability) => Math.max(best, probability),
      -Infinity,
    );
    if (maximum === -Infinity) return false;
    const logScale = Math.log(
      updated.reduce(
        (sum, probability) => sum + Math.exp(probability - maximum),
        0,
      ),
    );
    this.#logProbabilities = updated.map((probability) =>
      (probability - maximum) - logScale
    );
    return true;
  }

  /** Returns a conclusion when the winning posterior meets the threshold. */
  result(): SearchResult | null {
    const distribution = this.distribution;
    const confidence = distribution.max();
    if (confidence < this.#config.threshold) return null;
    const winner = distribution.argmax();
    return winner === this.#numSuspects
      ? { kind: "no_culprit", confidence }
      : { kind: "culprit", position: winner, confidence };
  }
}
