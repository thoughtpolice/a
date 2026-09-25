// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "@celld/assert";
import {
  type ChoiceAnswer,
  composite,
  gate,
  gateChoice,
  levelCount,
  mostLikelyLevel,
  normalizeScore,
  noulBand,
  ranked,
  type ScoreAnswer,
  topK,
} from "@celld/api/jev";

type Intent = "check_balance" | "approve_transfer" | "support";

function intent(choice: Intent, confidence: number): ChoiceAnswer<Intent> {
  return {
    type: "choice",
    choice,
    probabilities: { check_balance: 0.1, approve_transfer: 0.8, support: 0.1 },
    confidence,
  };
}

const levels = ["none", "some", "deep", "expert", "world class"] as const;

function level(
  scoreValue: number,
  probabilities: number[],
): ScoreAnswer<typeof levels> {
  return {
    type: "score",
    score: scoreValue,
    legend: {
      "0": "none",
      "1": "some",
      "2": "deep",
      "3": "expert",
      "4": "world class",
    },
    probabilities: {
      "0": probabilities[0],
      "1": probabilities[1],
      "2": probabilities[2],
      "3": probabilities[3],
      "4": probabilities[4],
    },
    confidence: 0.5,
  };
}

Deno.test("gate splits confidence three ways", () => {
  const thresholds = { act: 0.85, review: 0.6 };
  assertEquals(
    [0.9, 0.85, 0.7, 0.6, 0.59, 0].map((c) => gate(c, thresholds)),
    ["act", "act", "review", "review", "escalate", "escalate"],
  );
  assertEquals(gate(intent("support", 0.9), thresholds), "act");
  assertEquals(
    assertThrows(() => gate(0.5, { act: 0.5, review: 0.6 })).message,
    "act (0.5) must be at least review (0.6)",
  );
  assertEquals(
    assertThrows(() => gate(0.5, { act: 1.5, review: 0.6 })).message,
    "act must be a number from 0 to 1, got 1.5",
  );
});

Deno.test("gateChoice is the docs' voice-banking policy", () => {
  const policy = { floor: 0.6, act: { approve_transfer: 0.85 } };
  const route = (choice: Intent, confidence: number) =>
    gateChoice(intent(choice, confidence), policy).decision;
  assertEquals(route("check_balance", 0.55), "escalate");
  assertEquals(route("check_balance", 0.6), "act");
  assertEquals(route("approve_transfer", 0.7), "review");
  assertEquals(route("approve_transfer", 0.9), "act");
  assertEquals(gateChoice(intent("support", 0.99), policy), {
    decision: "act",
    choice: "support",
    confidence: 0.99,
  });
  assertEquals(
    assertThrows(() =>
      gateChoice(intent("support", 1), { floor: 0.6, act: { support: 0.5 } })
    ).message,
    "act.support (0.5) must be at least the floor (0.6)",
  );
});

Deno.test("ranking keeps asked order on ties", () => {
  const answer: ChoiceAnswer<"a" | "b" | "c" | "d"> = {
    type: "choice",
    choice: "b",
    probabilities: { a: 0.2, b: 0.4, c: 0.2, d: 0.2 },
    confidence: 0.3,
  };
  assertEquals(ranked(answer).map((r) => r.option), ["b", "a", "c", "d"]);
  assertEquals(topK(answer, 2), [
    { option: "b", probability: 0.4 },
    { option: "a", probability: 0.2 },
  ]);
  assertEquals(topK(answer, 10).length, 4);
  assertEquals(
    assertThrows(() => topK(answer, 0)).message,
    "k must be a positive integer, got 0",
  );
});

Deno.test("scores normalise and report their mode", () => {
  const answer = level(2, [0, 0.1, 0.8, 0.1, 0]);
  assertEquals(levelCount(answer), 5);
  assertEquals(normalizeScore(answer), 0.5);
  assertEquals(normalizeScore(level(4, [0, 0, 0, 0, 1])), 1);
  const mode: 0 | 1 | 2 | 3 | 4 = mostLikelyLevel(answer);
  assertEquals(mode, 2);
  assertEquals(mostLikelyLevel(level(2, [0.4, 0.2, 0, 0, 0.4])), 0);
});

Deno.test("noul bands keep an explicit uncertain middle", () => {
  const bands = { yes: 0.7, no: 0.3 };
  assertEquals(
    [1, 0.7, 0.5, 0.3, 0].map((p) => noulBand(p, bands)),
    ["yes", "yes", "uncertain", "no", "no"],
  );
  assertEquals(noulBand({ type: "noul", noul: 0.95 }, bands), "yes");
  assertEquals(
    assertThrows(() => noulBand(0.5, { yes: 0.5, no: 0.5 })).message,
    "no (0.5) must be below yes (0.5)",
  );
});

Deno.test("composite scores weigh normalised parts", () => {
  // The docs' senior-IC weights over four five-level scores.
  const result = composite(
    { python: 0.4, leadership: 0.1, design: 0.4, generalist: 0.1 },
    {
      python: level(4, [0, 0, 0, 0, 1]),
      leadership: level(0, [1, 0, 0, 0, 0]),
      design: level(2, [0, 0, 1, 0, 0]),
      generalist: { type: "noul", noul: 0.5 },
    },
  );
  assertEquals(Math.round(result.value * 1000) / 1000, 0.65);
  assertEquals(result.parts.python, {
    value: 1,
    weight: 0.4,
    contribution: 0.4,
  });
  assertEquals(result.parts.generalist.value, 0.5);
  // Weights need not sum to one: this is the weighted mean.
  assertEquals(composite({ a: 2, b: 2 }, { a: 1, b: 0 }).value, 0.5);
  assertEquals(
    assertThrows(() => composite({ a: 0 }, { a: 1 })).message,
    "at least one weight must be positive",
  );
  assertEquals(
    assertThrows(() => composite({ a: 1 }, { a: 3 })).message,
    "a must be a number from 0 to 1, got 3",
  );
});
