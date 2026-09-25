// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  choice,
  decodeModels,
  decodeResponse,
  JevDecodeError,
  noul,
  score,
} from "@celld/api/jev";
import { fakeBody } from "@celld/api/jev/testing";
import { formatPath } from "@celld/sieve";

const questions = {
  urgent: noul("Urgent?"),
  team: choice("Team?", {
    billing: "Payments",
    technical: "Bugs",
    sales: null,
  }),
  mood: score("Mood?", ["Calm", "Frustrated", "Very angry"]),
  shape: score("Fit?", [{ level: "poor" }, null]),
};

/** The documented example response, extended to all four questions. */
function documented(): Record<string, unknown> {
  return {
    model: "jev-1.13.0",
    answers: {
      urgent: { type: "noul", noul: 0.95 },
      team: {
        type: "choice",
        choice: "billing",
        probabilities: { billing: 0.88, technical: 0.12, sales: 0.0 },
        confidence: 0.81,
      },
      mood: {
        type: "score",
        score: 1.05,
        legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
        probabilities: { "0": 0.0, "1": 0.95, "2": 0.05 },
        confidence: 0.92,
      },
      shape: {
        type: "score",
        score: 0.5,
        legend: { "0": '{"level":"poor"}', "1": "" },
        probabilities: { "0": 0.5, "1": 0.5 },
        confidence: 0,
      },
    },
    usage: { input_tokens: 318, output_tokens: 34 },
  };
}

function failures(body: unknown, tolerance?: number): string[] {
  try {
    decodeResponse(body, questions, { probabilityTolerance: tolerance });
  } catch (error) {
    assert(error instanceof JevDecodeError, "decode error");
    assertEquals(error.kind, "decode");
    return error.issues.map((issue) =>
      `${formatPath(issue.path)}: ${issue.message}`
    );
  }
  throw new Error("expected a decode failure");
}

// deno-lint-ignore no-explicit-any
function mutate(change: (body: any) => void): Record<string, unknown> {
  const body = documented();
  change(body);
  return body;
}

Deno.test("the documented responses decode", () => {
  const decoded = decodeResponse(documented(), questions);
  assertEquals(decoded.model, "jev-1.13.0");
  assertEquals(decoded.usage, { input_tokens: 318, output_tokens: 34 });
  assertEquals(decoded.answers.urgent, { type: "noul", noul: 0.95 });
  assertEquals(decoded.answers.team, {
    type: "choice",
    choice: "billing",
    probabilities: { billing: 0.88, technical: 0.12, sales: 0 },
    confidence: 0.81,
  });
  assertEquals(decoded.answers.mood, {
    type: "score",
    score: 1.05,
    legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
    probabilities: { "0": 0, "1": 0.95, "2": 0.05 },
    confidence: 0.92,
  });
});

Deno.test("unknown fields are dropped, not passed through", () => {
  const decoded = decodeResponse(
    mutate((body) => {
      body.extra = 1;
      body.answers.urgent.reasoning = "because";
    }),
    questions,
  );
  assertEquals(decoded.answers.urgent, { type: "noul", noul: 0.95 });
  assert(!("extra" in decoded), "no extra top-level field");
});

Deno.test("every asked question must be answered, and nothing else", () => {
  assertEquals(
    failures(mutate((body) => {
      delete body.answers.urgent;
      body.answers.bonus = { type: "noul", noul: 1 };
    })),
    [
      "answers.urgent: the question asked was not answered",
      "answers.bonus: answers a question that was not asked",
    ],
  );
});

Deno.test("answer types must match their questions", () => {
  assertEquals(
    failures(mutate((body) => {
      body.answers.urgent = { type: "choice", choice: "x" };
    })),
    ['answers.urgent.type: expected "noul" to match the question, got "choice"'],
  );
});

Deno.test("choice options must be exactly those asked for", () => {
  assertEquals(
    failures(mutate((body) => {
      body.answers.team.choice = "marketing";
      body.answers.team.probabilities = {
        billing: 0.9,
        technical: 0.1,
        other: 0,
      };
    })),
    [
      'answers.team.choice: expected one of the options asked for, got "marketing"',
      "answers.team.probabilities.sales: missing from probabilities",
      "answers.team.probabilities.other: probabilities has a key that was not asked for",
    ],
  );
});

Deno.test("the choice must carry the largest probability", () => {
  assertEquals(
    failures(mutate((body) => {
      body.answers.team.choice = "technical";
    })),
    [
      'answers.team.choice: "technical" has probability 0.12, below the largest, 0.88',
    ],
  );
});

Deno.test("numbers must be finite and within 0 to 1", () => {
  assertEquals(
    failures(mutate((body) => {
      body.answers.urgent.noul = 1.5;
      body.answers.team.confidence = -0.1;
      body.answers.mood.probabilities["1"] = "0.95";
    })),
    [
      "answers.urgent.noul: must be at most 1",
      "answers.team.confidence: must be at least 0",
      'answers.mood.probabilities["1"]: expected number, received string',
    ],
  );
});

Deno.test("probability sums are strict within the tolerance", () => {
  const skewed = mutate((body) => {
    body.answers.team.probabilities = {
      billing: 0.88,
      technical: 0.1,
      sales: 0,
    };
  });
  assertEquals(failures(skewed), [
    "answers.team.probabilities: probabilities sum to 0.98, not 1 (±0.01)",
  ]);
  decodeResponse(skewed, questions, { probabilityTolerance: 0.05 });
  // Float error and two-decimal rounding pass by default.
  decodeResponse(
    mutate((body) => {
      body.answers.team.probabilities = {
        billing: 0.335,
        technical: 0.335,
        sales: 0.335,
      };
      body.answers.team.choice = "technical";
    }),
    questions,
  );
});

Deno.test("score keys, legend and range are checked", () => {
  assertEquals(
    failures(mutate((body) => {
      body.answers.mood.score = 2.5;
      body.answers.mood.legend = {
        "0": "Calm",
        "1": "Annoyed",
        "2": "Very angry",
        "3": "x",
      };
      body.answers.mood.probabilities = { "1": 1 };
    })),
    [
      "answers.mood.score: expected a score from 0 to 2, got 2.5",
      'answers.mood.legend["1"]: expected the level sent, "Frustrated", got "Annoyed"',
      'answers.mood.legend["3"]: legend has a key that was not asked for',
      'answers.mood.probabilities["0"]: missing from probabilities',
      'answers.mood.probabilities["2"]: missing from probabilities',
    ],
  );
});

Deno.test("structured levels may come back in any legend form", () => {
  const decoded = decodeResponse(
    mutate((body) => {
      body.answers.shape.legend = { "0": { level: "poor" }, "1": null };
    }),
    questions,
  );
  assertEquals(decoded.answers.shape, {
    type: "score",
    score: 0.5,
    legend: { "0": { level: "poor" }, "1": null },
    probabilities: { "0": 0.5, "1": 0.5 },
    confidence: 0,
  });
});

Deno.test("the envelope is checked too", () => {
  assertEquals(failures([]), [": expected object, received array"]);
  assertEquals(
    failures({
      model: "",
      answers: null,
      usage: { input_tokens: -1, output_tokens: 1.5 },
    }),
    [
      "model: must not be blank",
      "answers: expected object, received null",
      "usage.input_tokens: must be at least 0",
      "usage.output_tokens: expected int, received number",
    ],
  );
});

Deno.test("the testing fake satisfies the decoder", () => {
  const decoded = decodeResponse(fakeBody(questions), questions);
  assertEquals(decoded.answers.team, {
    type: "choice",
    choice: "billing",
    probabilities: { billing: 1, technical: 0, sales: 0 },
    confidence: 1,
  });
});

Deno.test("model listings decode strictly", () => {
  assertEquals(
    decodeModels({
      models: [{
        name: "jev-latest",
        description: "",
        release_date: "2026-08-01",
      }],
    }),
    [{ name: "jev-latest", description: "", release_date: "2026-08-01" }],
  );
  let error: unknown;
  try {
    decodeModels({
      models: [{ name: 1, description: null, release_date: "x" }],
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof JevDecodeError, "bad listing");
  assertEquals(error.issues.map((issue) => formatPath(issue.path)), [
    "models[0].name",
    "models[0].description",
    "models[0].release_date",
  ]);
});
