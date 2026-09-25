// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  type AnswerFor,
  type AnswersFor,
  choice,
  type ChoiceAnswer,
  isPinnedModel,
  JevClient,
  JevInvalidRequestError,
  type LevelIndex,
  type Model,
  noul,
  type NoulAnswer,
  score,
  type ScoreAnswer,
} from "@celld/api/jev";
import { fakeBody, fakeFetch, jsonResponse } from "@celld/api/jev/testing";

/** Compile-time equality: resolves to true only when A and B are identical. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

/** Fails to compile unless its argument's type is exactly `true`. */
function expectType<T extends true>(_proof?: T): void {}

function invalid(fn: () => unknown): JevInvalidRequestError {
  try {
    fn();
  } catch (error) {
    if (error instanceof JevInvalidRequestError) return error;
    throw error;
  }
  throw new Error("expected a JevInvalidRequestError");
}

Deno.test("noul builds the documented shape", () => {
  assertEquals(noul("Urgent?"), { type: "noul", instructions: "Urgent?" });
  assertEquals(
    noul("Urgent?", { true: "Time-sensitive", false: undefined }),
    {
      type: "noul",
      instructions: "Urgent?",
      criteria: { true: "Time-sensitive" },
    },
  );
  assertEquals(noul({ question: "Same person?", candidate: { name: "J" } }), {
    type: "noul",
    instructions: { question: "Same person?", candidate: { name: "J" } },
  });
});

Deno.test("choice takes a description map or a list of names", () => {
  assertEquals(choice("Team?", { billing: "Payments", technical: null }), {
    type: "choice",
    instructions: "Team?",
    criteria: { billing: "Payments", technical: null },
  });
  assertEquals(choice("Team?", ["billing", "technical"]), {
    type: "choice",
    instructions: "Team?",
    criteria: { billing: null, technical: null },
  });
});

Deno.test("score keeps the rubric", () => {
  assertEquals(score("Mood?", ["Calm", "Angry"]), {
    type: "score",
    instructions: "Mood?",
    criteria: ["Calm", "Angry"],
  });
});

Deno.test("builders refuse malformed questions where they are written", () => {
  assertEquals(invalid(() => noul("  ")).issues, [
    { code: "custom", path: ["instructions"], message: "must not be blank" },
  ]);
  assertEquals(invalid(() => noul("q", {})).issues.length, 1);
  assertEquals(
    invalid(() => choice("q", ["a", "b", "a"])).issues[0].path,
    ["criteria", 2],
  );
  assertEquals(
    invalid(() => choice("q", {})).issues[0].message,
    "a Choice needs at least one option",
  );
  const many = Array.from({ length: 256 }, (_, index) => `o${index}`);
  assert(
    invalid(() => choice("q", many)).message.includes("at most 255"),
    "256 options",
  );
  const levels = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
  // A runtime-length array escapes the compile-time level count.
  const eleven = levels as unknown as readonly [string, string, ...string[]];
  assert(
    invalid(() => score("q", eleven)).message.includes("at most 10"),
    "eleven levels",
  );
  assertEquals(
    invalid(() => score("q", ["", "b"])).issues[0].message,
    "must not be blank; use null for no description",
  );
});

Deno.test("answer types follow the questions", () => {
  const team = choice("Team?", {
    billing: "Payments",
    technical: "Bugs",
    sales: null,
  });
  const listed = choice("Team?", ["north", "south"]);
  const mood = score("Mood?", ["Calm", "Frustrated", "Very angry"]);
  const urgent = noul("Urgent?");

  expectType<Equal<AnswerFor<typeof urgent>, NoulAnswer>>(true);
  expectType<
    Equal<
      AnswerFor<typeof team>,
      ChoiceAnswer<"billing" | "technical" | "sales">
    >
  >(true);
  expectType<Equal<AnswerFor<typeof listed>, ChoiceAnswer<"north" | "south">>>(
    true,
  );
  type Mood = AnswerFor<typeof mood>;
  expectType<
    Equal<Mood, ScoreAnswer<readonly ["Calm", "Frustrated", "Very angry"]>>
  >(true);
  expectType<Equal<keyof Mood["legend"], "0" | "1" | "2">>(true);
  expectType<Equal<Mood["legend"]["1"], "Frustrated">>(true);
  expectType<Equal<keyof Mood["probabilities"], "0" | "1" | "2">>(true);
  expectType<
    Equal<LevelIndex<readonly ["Calm", "Frustrated", "Very angry"]>, 0 | 1 | 2>
  >(true);

  type All = AnswersFor<{ team: typeof team; mood: typeof mood }>;
  expectType<Equal<All["team"]["choice"], "billing" | "technical" | "sales">>(
    true,
  );

  // Raw objects written with `as const` type the same way.
  const raw = {
    type: "choice",
    instructions: "Pick",
    criteria: { yes: null, no: null },
  } as const;
  expectType<Equal<AnswerFor<typeof raw>["choice"], "yes" | "no">>(true);
});

Deno.test("misuse fails to compile", () => {
  const team = choice("Team?", ["billing", "technical"]);
  const answer: AnswerFor<typeof team> = {
    type: "choice",
    choice: "billing",
    probabilities: { billing: 1, technical: 0 },
    confidence: 1,
  };
  // @ts-expect-error: "sales" was never an option.
  const wrong: typeof answer.choice = "sales";
  // @ts-expect-error: a Choice answer has no noul.
  const noulOf = answer.noul;
  // @ts-expect-error: probabilities only have the options asked for.
  const missing = answer.probabilities.sales;
  // @ts-expect-error: a Score needs at least two levels.
  const one = () => score("q", ["only"]);
  const levels = [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
  ] as const;
  // @ts-expect-error: a Score takes at most ten levels.
  const eleven = () => score("q", levels);
  // @ts-expect-error: numbers are not text or structure.
  const number = () => noul(5);
  assertEquals([
    wrong,
    noulOf,
    missing,
    typeof one,
    typeof eleven,
    typeof number,
  ], [
    "sales",
    undefined,
    undefined,
    "function",
    "function",
    "function",
  ]);
});

Deno.test("ask returns answers typed by the questions, without casts", async () => {
  const fetch = fakeFetch(({ body }) =>
    jsonResponse(
      fakeBody(body.questions, {
        answers: {
          team: {
            choice: "technical",
            probabilities: { billing: 0.2, technical: 0.8 },
            confidence: 0.6,
          },
        },
      }),
    )
  );
  const client = new JevClient({ apiKey: "k", fetch });
  const { answers } = await client.ask({
    state: "Payouts fail",
    questions: {
      team: choice("Team?", ["billing", "technical"]),
      urgent: noul("Urgent?"),
      mood: score("Mood?", ["Calm", "Angry"]),
    },
  });
  const team: "billing" | "technical" = answers.team.choice;
  const yes: number = answers.urgent.noul;
  const calm: "Calm" = answers.mood.legend["0"];
  assertEquals([team, yes, calm], ["technical", 1, "Calm"]);
  // @ts-expect-error: no question has this id.
  const absent = answers.nothing;
  // @ts-expect-error: urgent is a Noul, which has no choice.
  const noChoice = answers.urgent.choice;
  assertEquals([absent, noChoice], [undefined, undefined]);
});

Deno.test("model names: aliases, versions, and pinning", () => {
  const models: Model[] = ["jev-latest", "jev-preview", "jev-1.13.0", "custom"];
  assertEquals(models.map(isPinnedModel), [false, false, true, false]);
  assert(!isPinnedModel("jev-1.13"), "two components");
  assert(isPinnedModel("jev-2.0.10"), "multi-digit patch");
});
