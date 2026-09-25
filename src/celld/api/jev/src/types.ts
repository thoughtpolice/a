// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The shapes of TypeSafe's System One API, typed so that answers follow from
 * the questions that were asked.
 *
 * A question's `criteria` carry its answer's type: a Choice over
 * `{billing, technical}` is answered by a {@link ChoiceAnswer} whose `choice`
 * is `"billing" | "technical"`, and a Score over a three-level tuple has
 * legend and probability keys `"0" | "1" | "2"`. {@link AnswersFor} maps a
 * whole `questions` object to its answers, so `client.ask` needs no casts.
 *
 * @module
 */

import type { JsonValue } from "./json.ts";

/**
 * Text or JSON structure: what `state`, `instructions` and every criterion
 * accept. The API takes a string, an object or an array; the client checks at
 * runtime that objects and arrays are plain JSON (so interfaces and classes
 * type-check here but a `Date` or a cycle is refused before sending).
 */
export type Entry = string | object;

/** The aliases TypeSafe moves when it ships a release. */
export type ModelAlias = "jev-latest" | "jev-preview";

/** A versioned model ID such as `jev-1.13.0`, which never moves. */
export type PinnedModel = `jev-${number}.${number}.${number}`;

/**
 * A model name: an alias, a versioned ID, or any other name the account can
 * use (`(string & {})` keeps editor completion for the known ones).
 */
// deno-lint-ignore ban-types
export type Model = ModelAlias | PinnedModel | (string & {});

/** Optional descriptions of what a yes and a no mean. */
export interface NoulCriteria {
  /** What a yes (a value near 1) means. */
  readonly true?: Entry | null;
  /** What a no (a value near 0) means. */
  readonly false?: Entry | null;
}

/** A yes/no question, answered with the probability of yes. */
export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: Entry;
  readonly criteria?: NoulCriteria;
}

/** Option names mapped to descriptions, or `null` for an undescribed option. */
export type ChoiceCriteria<O extends string = string> = {
  readonly [K in O]: Entry | null;
};

/** Picks one option from a set of 1 to 255. */
export interface ChoiceQuestion<O extends string = string> {
  readonly type: "choice";
  readonly instructions: Entry;
  readonly criteria: ChoiceCriteria<O>;
}

/** One level of a Score rubric. */
export type ScoreLevel = Entry | null;

/** An ordered rubric of at least two levels; the API accepts up to ten. */
export type ScoreLevels = readonly [ScoreLevel, ScoreLevel, ...ScoreLevel[]];

/** Rates the state against an ordered rubric. */
export interface ScoreQuestion<L extends ScoreLevels = ScoreLevels> {
  readonly type: "score";
  readonly instructions: Entry;
  readonly criteria: L;
}

/** Any question, discriminated by `type`. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Questions keyed by the ids their answers come back under. */
export type Questions = { readonly [id: string]: Question };

/** The option names of Choice criteria, as strings. */
export type OptionOf<C> = `${Extract<keyof C, string | number>}`;

/**
 * The level keys of a Score rubric: `"0" | "1" | "2"` for a three-level
 * tuple, or any numeric string when the length is not known statically.
 */
export type LevelKey<L extends readonly unknown[]> = number extends L["length"]
  ? `${number}`
  : Extract<keyof L, `${number}`>;

type ToNumber<K> = K extends `${infer N extends number}` ? N : never;

/** The level indices of a Score rubric: `0 | 1 | 2` for three levels. */
export type LevelIndex<L extends readonly unknown[]> = number extends
  L["length"] ? number
  : ToNumber<LevelKey<L>>;

/** What the legend holds for a level: the level text itself for a string. */
export type LegendEntry<V> = V extends string ? V : JsonValue;

/** A yes/no answer. */
export interface NoulAnswer {
  readonly type: "noul";
  /** Probability of yes, from 0 to 1. */
  readonly noul: number;
}

/** The chosen option, every option's probability, and the confidence. */
export interface ChoiceAnswer<O extends string = string> {
  readonly type: "choice";
  /** The highest-probability option. */
  readonly choice: O;
  /** Every option's probability; they sum to 1. */
  readonly probabilities: { readonly [K in O]: number };
  /** How certain the model is, from 0 to 1, derived from `probabilities`. */
  readonly confidence: number;
}

/** A probability-weighted score, the rubric, and the confidence. */
export interface ScoreAnswer<L extends readonly unknown[] = ScoreLevels> {
  readonly type: "score";
  /** The expected level, from 0 to the last level; may fall between levels. */
  readonly score: number;
  /** Each level number mapped back to its description. */
  readonly legend: {
    readonly [K in LevelKey<L>]: K extends keyof L ? LegendEntry<L[K]>
      : JsonValue;
  };
  /** Each level's probability; they sum to 1. */
  readonly probabilities: { readonly [K in LevelKey<L>]: number };
  /** How certain the model is, from 0 to 1, derived from `probabilities`. */
  readonly confidence: number;
}

/** Any answer. */
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The answer type for one question. */
export type AnswerFor<Q> = Q extends { readonly type: "noul" } ? NoulAnswer
  : Q extends { readonly type: "choice"; readonly criteria: infer C }
    ? ChoiceAnswer<OptionOf<C>>
  : Q extends {
    readonly type: "score";
    readonly criteria: infer L extends readonly unknown[];
  } ? ScoreAnswer<L>
  : never;

/** The answers for a `questions` object, under the same ids. */
export type AnswersFor<Qs> = { readonly [K in keyof Qs]: AnswerFor<Qs[K]> };

/** What `JevClient.ask` sends: the state and the questions about it. */
export interface JevRequest<Qs extends Questions = Questions> {
  /** The content to evaluate: text, or a JSON object or array. */
  readonly state: Entry;
  /** At least one question, keyed by the id its answer comes back under. */
  readonly questions: Qs;
  /** Overrides the client's model for this request. */
  readonly model?: Model;
}

/** Token usage the API reports. Pricing is per input token. */
export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/** How the answer cache took part in a request. */
export type CacheStatus =
  /** Answered from the cache without calling the API. */
  | "hit"
  /** Not cached yet; the API answered and the result was stored. */
  | "miss"
  /** The model is an alias, whose answers can change, so no cache was used. */
  | "bypass"
  /** No cache is configured. */
  | "off";

/** Facts about how a result was obtained. Plain data. */
export interface ResultMeta {
  /** The model named in the request, which may be an alias. */
  readonly requestedModel: string;
  /** HTTP attempts made, including retries; 0 for a cache hit. */
  readonly attempts: number;
  /** Milliseconds from the call to the decoded result, including waits. */
  readonly latencyMs: number;
  /** The `x-typesafe-request-id` of the answering response, if it had one. */
  readonly requestId: string | null;
  /** What the answer cache did. */
  readonly cache: CacheStatus;
}

/**
 * A decoded answer set: plain data, so it can cross Durable Object RPC,
 * Workflow steps and queues unchanged.
 */
export interface JevResult<Qs extends Questions = Questions> {
  /** The versioned model ID that answered, such as `jev-1.13.0`. */
  readonly model: string;
  readonly answers: AnswersFor<Qs>;
  readonly usage: Usage;
  readonly meta: ResultMeta;
}

/** One entry of `GET /v1/models`. */
export interface ModelCard {
  /** The model ID or alias, as accepted by the `model` field. */
  readonly name: string;
  readonly description: string;
  readonly release_date: string;
}

/**
 * A rate-limit decision: go ahead, or wait this long and ask again. Plain data,
 * so a Durable Object can return it over RPC.
 */
export type LimiterDecision =
  | { readonly granted: true }
  | { readonly granted: false; readonly waitMs: number };

/**
 * Admission control consulted before every HTTP attempt. The client asks
 * {@link Limiter.acquire} for one request (reserving `reserveTokens`, 0 by
 * default, because token counts are only known afterwards), then reports the
 * response's actual `usage.input_tokens` to {@link Limiter.settle}, and passes
 * a server `retry-after` on 429/529 to {@link Limiter.throttle} so every
 * caller sharing the limiter backs off. `@celld/api/jev/limiter` has an
 * in-memory one and the adapter for the Durable Object in `@celld/api/jev/durable`.
 */
export interface Limiter {
  acquire(
    request: { readonly reserveTokens: number },
  ): LimiterDecision | Promise<LimiterDecision>;
  settle(
    charge: { readonly reservedTokens: number; readonly actualTokens: number },
  ): void | Promise<void>;
  throttle?(request: { readonly retryAfterMs: number }): void | Promise<void>;
}

/**
 * Storage for answers to requests pinned to a versioned model. Values are the
 * validated response bodies; the client decodes them again on a hit, so a
 * corrupt or stale entry is a miss, never a wrong answer. `@celld/api/jev/cache`
 * has KV and in-memory implementations.
 */
export interface AnswerCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
