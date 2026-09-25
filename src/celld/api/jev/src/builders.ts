// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Question builders that keep the criteria's literal types, so answers are
 * typed by what was asked, and that check the question as they build it, so a
 * malformed one fails where it is written rather than at the call.
 *
 * ```ts
 * const questions = {
 *   urgent: noul("Does this convey urgency?"),
 *   team: choice("Which team should handle this?", {
 *     billing: "Payments, invoicing, refunds",
 *     technical: "Bugs, outages, integrations",
 *   }),
 *   mood: score("How frustrated is the customer?", [
 *     "Calm",
 *     "Frustrated",
 *     "Very angry",
 *   ]),
 * };
 * ```
 *
 * @module
 */

import { type Issue, JevInvalidRequestError } from "./errors.ts";
import { QuestionSchema } from "./schemas.ts";
import type {
  ChoiceCriteria,
  ChoiceQuestion,
  Entry,
  Model,
  NoulCriteria,
  NoulQuestion,
  OptionOf,
  ScoreLevels,
  ScoreQuestion,
} from "./types.ts";

function checked<Q>(question: Q, extra: Issue[] = []): Q {
  const result = QuestionSchema.safeParse(question);
  const issues = result.success ? extra : [...extra, ...result.error.issues];
  if (issues.length > 0) throw new JevInvalidRequestError(issues);
  return question;
}

/**
 * A yes/no question. `criteria` may describe what a yes and a no mean; an
 * absent or `undefined` side is left out.
 *
 * @throws {JevInvalidRequestError} blank instructions or criteria.
 */
export function noul(
  instructions: Entry,
  criteria?: NoulCriteria,
): NoulQuestion {
  if (criteria === undefined) return checked({ type: "noul", instructions });
  const described: { true?: Entry | null; false?: Entry | null } = {};
  if (criteria.true !== undefined) described.true = criteria.true;
  if (criteria.false !== undefined) described.false = criteria.false;
  return checked({ type: "noul", instructions, criteria: described });
}

/**
 * A Choice among named options. Pass either options mapped to descriptions
 * (`null` for none) or a list of option names:
 *
 * ```ts
 * choice("Which team?", { billing: "Payments", technical: null });
 * choice("Which team?", ["billing", "technical"]);
 * ```
 *
 * The answer's `choice` is typed as the union of the option names.
 *
 * @throws {JevInvalidRequestError} no options, more than 255, blank or
 * duplicate names, or blank descriptions.
 */
export function choice<const O extends readonly string[]>(
  instructions: Entry,
  options: O,
): ChoiceQuestion<O[number]>;
export function choice<
  const C extends { readonly [option: string]: Entry | null },
>(instructions: Entry, criteria: C): ChoiceQuestion<OptionOf<C>>;
export function choice(
  instructions: Entry,
  criteria: readonly string[] | { readonly [option: string]: Entry | null },
): ChoiceQuestion {
  if (!Array.isArray(criteria)) {
    return checked({
      type: "choice",
      instructions,
      criteria: criteria as ChoiceCriteria,
    });
  }
  const issues: Issue[] = [];
  const described: Record<string, null> = {};
  (criteria as readonly unknown[]).forEach((option, index) => {
    if (typeof option !== "string") {
      issues.push({
        code: "custom",
        path: ["criteria", index],
        message: "option names must be strings",
      });
    } else if (Object.hasOwn(described, option)) {
      issues.push({
        code: "custom",
        path: ["criteria", index],
        message: `duplicate option ${JSON.stringify(option)}`,
      });
    } else {
      described[option] = null;
    }
  });
  return checked({ type: "choice", instructions, criteria: described }, issues);
}

type CountOk<L extends readonly unknown[]> = number extends L["length"]
  ? unknown
  : L["length"] extends 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 ? unknown
  : { "a Score takes 2 to 10 levels": never };

/**
 * A Score against an ordered rubric of 2 to 10 levels, lowest first. With a
 * literal tuple the answer's legend and probability keys are typed as its
 * indices, and string levels come back in the legend as themselves.
 *
 * @throws {JevInvalidRequestError} fewer than 2 or more than 10 levels, or
 * blank levels.
 */
export function score<const L extends ScoreLevels>(
  instructions: Entry,
  levels: L & CountOk<L>,
): ScoreQuestion<L> {
  return checked({ type: "score", instructions, criteria: levels as L });
}

const PINNED = /^[a-z][a-z0-9_-]*-\d+\.\d+\.\d+$/;

/**
 * Whether a model name is a versioned ID (`jev-1.13.0`) rather than an alias
 * such as `jev-latest`. Only versioned IDs answer the same way tomorrow, so
 * only they are cached and only they should back tuned thresholds.
 */
export function isPinnedModel(model: Model): boolean {
  return PINNED.test(model);
}
