// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Small, pure functions for the patterns in TypeSafe's docs: confidence-gated
 * routing, ranking options, normalising and combining scores, and banding
 * Noul probabilities with an explicit uncertain middle.
 *
 * None of them computes a confidence of its own: the API's `confidence` is
 * the documented measure, and these read it as given. Thresholds are the
 * caller's; the docs are clear that they depend on the stakes and should be
 * tuned against a pinned model.
 *
 * @module
 */

import type {
  ChoiceAnswer,
  LevelIndex,
  NoulAnswer,
  ScoreAnswer,
} from "./types.ts";

/** A three-way routing decision. */
export type Decision = "act" | "review" | "escalate";

/** Confidence floors for {@link gate}; `act` must be at least `review`. */
export interface GateThresholds {
  /** At or above this, act automatically. */
  readonly act: number;
  /** At or above this (and below `act`), act with review or confirmation. */
  readonly review: number;
}

function unit(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a number from 0 to 1, got ${value}`);
  }
  return value;
}

/**
 * Routes on confidence: `"act"` at or above `act`, `"review"` at or above
 * `review`, otherwise `"escalate"`. Takes a Choice or Score answer, or a
 * confidence.
 *
 * ```ts
 * switch (gate(answers.intent, { act: 0.85, review: 0.6 })) { ... }
 * ```
 *
 * @throws {RangeError} thresholds outside 0 to 1, or `act` below `review`.
 */
export function gate(
  answer: { readonly confidence: number } | number,
  thresholds: GateThresholds,
): Decision {
  const act = unit("act", thresholds.act);
  const review = unit("review", thresholds.review);
  if (act < review) {
    throw new RangeError(`act (${act}) must be at least review (${review})`);
  }
  const confidence = typeof answer === "number" ? answer : answer.confidence;
  if (confidence >= act) return "act";
  return confidence >= review ? "review" : "escalate";
}

/** Per-option confidence policy for {@link gateChoice}. */
export interface ChoiceGate<O extends string> {
  /** Below this confidence, escalate whatever was chosen. */
  readonly floor: number;
  /**
   * The confidence needed to act on each option without review; options not
   * listed act at the floor. High-stakes options get higher bars.
   */
  readonly act?: { readonly [K in O]?: number };
}

/** A Choice routing decision, with what was chosen. */
export interface ChoiceDecision<O extends string> {
  readonly decision: Decision;
  readonly choice: O;
  readonly confidence: number;
}

/**
 * The docs' confidence-gated routing: escalate below the floor, act when the
 * chosen option's own bar is met, and review in between.
 *
 * ```ts
 * const { decision, choice } = gateChoice(answers.intent, {
 *   floor: 0.6,
 *   act: { approve_transfer: 0.85 },
 * });
 * ```
 *
 * @throws {RangeError} a threshold outside 0 to 1, or an option's bar below
 * the floor.
 */
export function gateChoice<O extends string>(
  answer: ChoiceAnswer<O>,
  policy: ChoiceGate<O>,
): ChoiceDecision<O> {
  const floor = unit("floor", policy.floor);
  const bars: { readonly [K in O]?: number } = policy.act ?? {};
  for (const [option, bar] of Object.entries(bars)) {
    if (bar === undefined) continue;
    unit(`act.${option}`, bar as number);
    if ((bar as number) < floor) {
      throw new RangeError(
        `act.${option} (${bar}) must be at least the floor (${floor})`,
      );
    }
  }
  const { choice, confidence } = answer;
  const bar = bars[choice] ?? floor;
  const decision: Decision = confidence < floor
    ? "escalate"
    : confidence >= bar
    ? "act"
    : "review";
  return { decision, choice, confidence };
}

/** An option and its probability. */
export interface Ranked<O extends string> {
  readonly option: O;
  readonly probability: number;
}

/**
 * Options from most to least probable. Ties keep the order the options were
 * asked in, which is the order the client decodes them in.
 */
export function ranked<O extends string>(
  answer: { readonly probabilities: { readonly [K in O]: number } },
): Ranked<O>[] {
  return (Object.entries(answer.probabilities) as [O, number][])
    .map(([option, probability]) => ({ option, probability }))
    .sort((a, b) => b.probability - a.probability);
}

/**
 * The `k` most probable options, as for re-checking the top candidates or a
 * beam search down a taxonomy.
 *
 * @throws {RangeError} a `k` that is not a positive integer.
 */
export function topK<O extends string>(
  answer: { readonly probabilities: { readonly [K in O]: number } },
  k: number,
): Ranked<O>[] {
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError(`k must be a positive integer, got ${k}`);
  }
  return ranked(answer).slice(0, k);
}

/** A Score answer of any rubric, for the helpers below. */
export type AnyScoreAnswer = ScoreAnswer<readonly unknown[]>;

/** How many levels a Score answer's rubric has. */
export function levelCount(answer: AnyScoreAnswer): number {
  return Object.keys(answer.probabilities).length;
}

/**
 * The score scaled to 0 to 1 (`score / (levels - 1)`), as the docs' composite
 * scoring does before weighting.
 */
export function normalizeScore(answer: AnyScoreAnswer): number {
  const top = levelCount(answer) - 1;
  if (top < 1) throw new RangeError("a Score answer needs at least two levels");
  return Math.min(1, Math.max(0, answer.score / top));
}

/**
 * The single most probable level (the mode), where `score` is the
 * probability-weighted mean. Ties go to the lower level.
 */
export function mostLikelyLevel<L extends readonly unknown[]>(
  answer: ScoreAnswer<L>,
): LevelIndex<L> {
  const probabilities = answer.probabilities as Record<string, number>;
  let best = 0;
  for (let level = 1; level < Object.keys(probabilities).length; level++) {
    if (probabilities[String(level)] > probabilities[String(best)]) {
      best = level;
    }
  }
  return best as LevelIndex<L>;
}

/** Probability bands for {@link noulBand}; `no` must be below `yes`. */
export interface NoulBands {
  /** At or above this, yes. */
  readonly yes: number;
  /** At or below this, no. */
  readonly no: number;
}

/**
 * Reads a Noul as `"yes"`, `"no"`, or `"uncertain"` in between, so the
 * middle is routed deliberately (to review, say) instead of rounded away.
 *
 * @throws {RangeError} bands outside 0 to 1, or `no` not below `yes`.
 */
export function noulBand(
  answer: NoulAnswer | number,
  bands: NoulBands,
): "yes" | "no" | "uncertain" {
  const yes = unit("yes", bands.yes);
  const no = unit("no", bands.no);
  if (no >= yes) {
    throw new RangeError(`no (${no}) must be below yes (${yes})`);
  }
  const p = typeof answer === "number" ? answer : answer.noul;
  if (p >= yes) return "yes";
  return p <= no ? "no" : "uncertain";
}

/** One input to {@link composite}: its 0-to-1 value, weight and share. */
export interface CompositePart {
  /** The input scaled to 0 to 1. */
  readonly value: number;
  readonly weight: number;
  /** `weight * value / total weight`: its share of the composite. */
  readonly contribution: number;
}

/** A composite score and how each input contributed to it. */
export interface Composite<K extends string> {
  /** The weighted mean of the inputs, from 0 to 1. */
  readonly value: number;
  readonly parts: { readonly [P in K]: CompositePart };
}

/**
 * Combines atomic judgments with weights kept in code, as in the docs'
 * composite scoring: Score answers are normalised to 0 to 1, Noul answers
 * contribute their probability, and plain numbers must already be 0 to 1.
 * The result is the weighted mean, so weights need not sum to 1, and the
 * parts show each input's contribution.
 *
 * ```ts
 * const ic = composite(
 *   { python: 0.4, leadership: 0.1, design: 0.4, generalist: 0.1 },
 *   answers,
 * );
 * ```
 *
 * @throws {RangeError} a negative or non-finite weight, all weights zero, or
 * a number outside 0 to 1.
 */
export function composite<K extends string>(
  weights: { readonly [P in K]: number },
  values: { readonly [P in NoInfer<K>]: AnyScoreAnswer | NoulAnswer | number },
): Composite<K> {
  const keys = Object.keys(weights) as K[];
  let total = 0;
  for (const key of keys) {
    const weight = weights[key];
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(`weight ${key} must be non-negative, got ${weight}`);
    }
    total += weight;
  }
  if (total <= 0) throw new RangeError("at least one weight must be positive");
  const scaled = keys.map((key) => {
    const input = values[key];
    if (typeof input === "number") return unit(key, input);
    if (input.type === "noul") return input.noul;
    return normalizeScore(input);
  });
  const parts = {} as { [P in K]: CompositePart };
  let value = 0;
  keys.forEach((key, index) => {
    const contribution = weights[key] * scaled[index] / total;
    parts[key] = { value: scaled[index], weight: weights[key], contribution };
    value += contribution;
  });
  return { value, parts };
}
