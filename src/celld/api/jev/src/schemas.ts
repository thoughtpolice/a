// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The System One API as sieve schemas: what a request may send, checked
 * before anything is sent, and what a response must answer, checked against
 * the questions that were asked.
 *
 * **Requests.** A request the API would refuse costs a round trip and, under
 * a rate limit, a slot; one it would accept but read differently from what
 * was meant (an `undefined` criterion silently dropped, a `Date` sent as a
 * string, a mistyped `critera` ignored) costs a wrong answer. The request
 * schemas report every such problem at once, with its path. They do not count
 * tokens: the docs give no tokenizer, and the server's 422 remains the
 * authority on size. Where the docs leave room they take the stricter
 * reading, so a request that passes is one the documented API accepts as
 * written: empty instructions, descriptions and levels are refused (use
 * `null` for "no description"), unknown question fields are refused, and a
 * Noul's `criteria` must describe at least one of `true` and `false` when
 * present.
 *
 * **Responses.** The typed answers are a promise that `answers.team.choice`
 * is one of the options sent; {@link responseSchema} is where it is kept. A
 * response must answer every question and no other, with each answer's
 * `type` matching its question. Choice probabilities must cover exactly the
 * options sent, and `choice` must be one of them with the highest
 * probability. Score probabilities and legend must cover exactly the levels
 * `"0"` to `"n-1"`, and the legend must repeat every string level verbatim.
 * `score` must lie within 0 to n-1. Every probability, `noul` and
 * `confidence` must be a finite number from 0 to 1, and token counts
 * non-negative integers. Probability sums are checked strictly: the docs say
 * each distribution sums to 1, so a sum further than the tolerance (default
 * 0.01, which absorbs float error and light rounding) from 1 is an error, as
 * is a `choice` whose probability is more than that below the largest.
 * Unknown fields on answers and on the body are dropped, so a new server
 * field cannot break old clients or leak into results.
 *
 * The named schemas (`.meta({ id })`) are also written as JSON Schema at
 * build time; see `:schemas-json-schema` in the BUILD file.
 *
 * @module
 */

import { type Issue, type Schema, v } from "@celld/sieve";
import type { Answer, ModelCard, Question, Questions, Usage } from "./types.ts";

// ---------------------------------------------------------------------------
// Requests

/** Unknown keys are reported one by one, at their own paths. */
const EACH_KEY = { perKey: true } as const;

/** The most options a Choice may have. */
const MAX_CHOICE_OPTIONS = 255;

/** A string with something other than whitespace in it. */
function nonBlank(message = "must not be blank") {
  return v.string().regex(/\S/, message);
}

/**
 * Text or structure: a JSON value that is a string, an object or an array.
 * `blank` allows a blank string, `empty` an empty object or array; `hint` is
 * appended to the blank and empty messages.
 */
function entry(
  options: { blank?: boolean; empty?: boolean; hint?: string } = {},
) {
  const hint = options.hint === undefined ? "" : `; ${options.hint}`;
  return v.json().check((ctx) => {
    const value = ctx.value;
    if (value === null) {
      ctx.addIssue("must not be null");
    } else if (typeof value === "string") {
      if (!options.blank && value.trim() === "") {
        ctx.addIssue(`must not be blank${hint}`);
      }
    } else if (typeof value !== "object") {
      ctx.addIssue(
        `expected a string, object or array, received ${typeof value}`,
      );
    } else if (
      !options.empty &&
      (Array.isArray(value) ? value.length : Object.keys(value).length) === 0
    ) {
      ctx.addIssue(`must not be empty${hint}`);
    }
  });
}

/** What JSON Schema says about an entry: text, or non-empty structure. */
const ENTRY_FORMS = [
  { type: "string", pattern: "\\S" },
  { type: "object", minProperties: 1 },
  { type: "array", minItems: 1 },
];

/**
 * An instruction: non-blank text, or a non-empty plain JSON object or array
 * (checked as deeply as `v.json()` checks: no `undefined`, `Date`s, cycles,
 * ...). Never `null`.
 */
export const EntrySchema = entry().meta({
  id: "Entry",
  description:
    "Text, or a non-empty JSON object or array: what instructions and criteria accept.",
  anyOf: ENTRY_FORMS,
});

/**
 * A criterion (a Noul side, a Choice option's description or a Score level):
 * an {@link EntrySchema}, or `null` for no description.
 */
export const CriterionSchema = entry({
  hint: "use null for no description",
}).meta({ anyOf: ENTRY_FORMS }).nullable().meta({
  id: "Criterion",
  description: "An entry, or null for no description.",
});

/**
 * The state to evaluate: text or a JSON object or array, which may be blank
 * or empty. Never `null`.
 */
export const StateSchema = entry({ blank: true, empty: true }).meta({
  id: "State",
  description: "The content to evaluate: text, or a JSON object or array.",
  anyOf: [{ type: "string" }, { type: "object" }, { type: "array" }],
});

/** A model name: an alias, a versioned ID, or any other non-blank name. */
export const ModelNameSchema = nonBlank().meta({
  id: "ModelName",
  description:
    "An alias such as jev-latest, or a versioned ID such as jev-1.13.0.",
});

/** A yes/no question, answered with the probability of yes. */
export const NoulQuestionSchema = v.strictObject({
  type: v.literal("noul"),
  instructions: EntrySchema,
  criteria: v.strictObject({
    true: CriterionSchema.optional(),
    false: CriterionSchema.optional(),
  }, EACH_KEY).refine(
    (criteria) => criteria.true !== undefined || criteria.false !== undefined,
    "must describe true or false; omit it for none",
  ).meta({ minProperties: 1 }).optional(),
}, EACH_KEY).meta({ id: "NoulQuestion" });

/** A Choice among 1 to 255 named options. */
export const ChoiceQuestionSchema = v.strictObject({
  type: v.literal("choice"),
  instructions: EntrySchema,
  criteria: v.record(
    nonBlank("option names must not be blank"),
    CriterionSchema,
  ).check((ctx) => {
    const count = Object.keys(ctx.value).length;
    if (count === 0) ctx.addIssue("a Choice needs at least one option");
    if (count > MAX_CHOICE_OPTIONS) {
      ctx.addIssue(
        `a Choice has at most ${MAX_CHOICE_OPTIONS} options, got ${count}`,
      );
    }
  }).meta({ minProperties: 1, maxProperties: MAX_CHOICE_OPTIONS }),
}, EACH_KEY).meta({ id: "ChoiceQuestion" });

/** A Score against an ordered rubric of 2 to 10 levels, lowest first. */
export const ScoreQuestionSchema = v.strictObject({
  type: v.literal("score"),
  instructions: EntrySchema,
  criteria: v.array(CriterionSchema)
    .min(2, "a Score needs at least 2 levels")
    .max(10, "a Score has at most 10 levels"),
}, EACH_KEY).meta({ id: "ScoreQuestion" });

/** Any question, told apart by `type`. */
export const QuestionSchema = v.discriminatedUnion("type", [
  NoulQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
]).meta({ id: "Question" });

/** At least one question, keyed by the id its answer comes back under. */
export const QuestionsSchema = v.record(
  v.string().min(1, "question ids must not be empty"),
  QuestionSchema,
).refine(
  (questions) => Object.keys(questions).length > 0,
  "ask at least one question",
).meta({ id: "Questions", minProperties: 1 });

/** Fails a missing value with `message` before `schema` sees it. */
function required<T extends Schema<unknown, unknown>>(
  schema: T,
  message: string,
) {
  return v.unknown().refine((value) => value !== undefined, message).pipe(
    schema,
  );
}

/** The body of `POST /v1/systemone`. */
export const AskRequestSchema = v.strictObject({
  model: ModelNameSchema,
  state: required(StateSchema, "state is required"),
  questions: QuestionsSchema,
}, EACH_KEY).meta({
  id: "AskRequest",
  description: "The body of POST /v1/systemone.",
});

/**
 * Every problem with a request's `model`, `state` and `questions`, with
 * paths from the request body (`questions.dept.criteria`). Fields other than
 * those three are reported as unrecognized, each at its own path.
 */
export function requestIssues(request: object, model: unknown): Issue[] {
  const result = AskRequestSchema.safeParse({ ...request, model });
  return result.success ? [] : [...result.error.issues];
}

// ---------------------------------------------------------------------------
// Responses

/** Leaves room for float error when comparing a score with its range. */
const EPSILON = 1e-9;

/** How strictly to decode. */
export interface DecodeOptions {
  /**
   * How far a probability sum may be from 1, and how far below the largest
   * probability the chosen option's may be. Default 0.01.
   */
  readonly probabilityTolerance?: number;
}

/** The default {@link DecodeOptions.probabilityTolerance}. */
export const DEFAULT_PROBABILITY_TOLERANCE = 0.01;

/** A decoded System One response body, before client metadata is added. */
export interface DecodedResponse {
  readonly model: string;
  readonly answers: { readonly [id: string]: Answer };
  readonly usage: Usage;
}

const unit = v.number().min(0).max(1);

/** Token usage, as every response reports it. */
export const UsageSchema: Schema<Usage> = v.object({
  input_tokens: v.int().nonnegative(),
  output_tokens: v.int().nonnegative(),
}).meta({ id: "Usage" });

/** One entry of `GET /v1/models`. */
export const ModelCardSchema: Schema<ModelCard> = v.object({
  name: nonBlank(),
  description: v.string(),
  release_date: v.iso.date(),
}).meta({ id: "ModelCard" });

/** The body of `GET /v1/models`. */
export const ModelListSchema = v.object({
  models: v.array(ModelCardSchema),
}).meta({ id: "ModelList" });

/** Exactly `expected`; `what` explains why, and the value found is shown. */
function same(expected: unknown, what: string) {
  return v.unknown().check((ctx) => {
    if (ctx.value !== expected) {
      ctx.addIssue(
        `expected ${what}, got ${
          JSON.stringify(ctx.value) ?? String(ctx.value)
        }`,
      );
    }
  });
}

/** An object with exactly `keys`, each read with `value`. */
function exactly(
  keys: readonly string[],
  value: (key: string) => Schema<unknown, unknown>,
  what: string,
) {
  return v.object(
    Object.fromEntries(
      keys.map((key) => [key, required(value(key), `missing from ${what}`)]),
    ),
  ).strict({
    perKey: true,
    message: `${what} has a key that was not asked for`,
  });
}

/** Probabilities over exactly `keys`, summing to 1 within `tolerance`. */
function distribution(keys: readonly string[], tolerance: number) {
  return exactly(keys, () => unit, "probabilities").check((ctx) => {
    const sum = Object.values(ctx.value as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    if (Math.abs(sum - 1) > tolerance) {
      ctx.addIssue(`probabilities sum to ${sum}, not 1 (±${tolerance})`);
    }
  });
}

function noulAnswer() {
  return v.object({ type: v.literal("noul"), noul: unit });
}

function choiceAnswer(options: readonly string[], tolerance: number) {
  return v.object({
    type: v.literal("choice"),
    choice: v.string().check((ctx) => {
      if (!options.includes(ctx.value)) {
        ctx.addIssue(
          `expected one of the options asked for, got ${
            JSON.stringify(ctx.value)
          }`,
        );
      }
    }),
    probabilities: distribution(options, tolerance),
    confidence: unit,
  }).check((ctx) => {
    const { choice, probabilities } = ctx.value as {
      choice: string;
      probabilities: Record<string, number>;
    };
    const top = Math.max(...Object.values(probabilities));
    if (probabilities[choice] < top - tolerance) {
      ctx.addIssue({
        path: ["choice"],
        message: `${JSON.stringify(choice)} has probability ${
          probabilities[choice]
        }, below the largest, ${top}`,
      });
    }
  });
}

function scoreAnswer(levels: readonly unknown[], tolerance: number) {
  const keys = levels.map((_, index) => String(index));
  const last = levels.length - 1;
  return v.object({
    type: v.literal("score"),
    score: v.number().check((ctx) => {
      if (ctx.value < -EPSILON || ctx.value > last + EPSILON) {
        ctx.addIssue(`expected a score from 0 to ${last}, got ${ctx.value}`);
      }
    }).transform((score) => Math.min(last, Math.max(0, score))),
    legend: exactly(keys, (key) => {
      const level = levels[Number(key)];
      return typeof level === "string"
        ? same(level, `the level sent, ${JSON.stringify(level)}`)
        : v.json();
    }, "legend"),
    probabilities: distribution(keys, tolerance),
    confidence: unit,
  });
}

function answerSchema(question: Question, tolerance: number) {
  const body = question.type === "noul"
    ? noulAnswer()
    : question.type === "choice"
    ? choiceAnswer(Object.keys(question.criteria), tolerance)
    : scoreAnswer(question.criteria, tolerance);
  // The type is checked on its own first, so an answer of the wrong type is
  // one issue, not one per field.
  return required(
    v.looseObject({
      type: same(
        question.type,
        `${JSON.stringify(question.type)} to match the question`,
      ),
    }).pipe(body),
    "the question asked was not answered",
  );
}

/**
 * The schema a `POST /v1/systemone` body must match to answer `questions`:
 * see the module documentation for the rules. Its output is a
 * {@link DecodedResponse}, with unknown fields dropped and each `score`
 * clamped to its range.
 */
export function responseSchema(
  questions: Questions,
  options: DecodeOptions = {},
): Schema<DecodedResponse> {
  const tolerance = options.probabilityTolerance ??
    DEFAULT_PROBABILITY_TOLERANCE;
  const answers = Object.fromEntries(
    Object.keys(questions).map((id) => [
      id,
      answerSchema(questions[id], tolerance),
    ]),
  );
  return v.object({
    model: nonBlank(),
    answers: v.object(answers).strict({
      perKey: true,
      message: "answers a question that was not asked",
    }),
    usage: UsageSchema,
  }) as unknown as Schema<DecodedResponse>;
}
