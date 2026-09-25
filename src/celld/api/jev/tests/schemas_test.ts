// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  AskRequestSchema,
  type Issue,
  JevClient,
  JevInvalidRequestError,
  QuestionSchema,
  requestIssues,
  StateSchema,
} from "@celld/api/jev";
import { fakeFetch, jsonResponse } from "@celld/api/jev/testing";
import { formatPath, type Schema } from "@celld/sieve";

function paths(issues: readonly Issue[]): string[] {
  return issues.map((issue) => formatPath(issue.path));
}

function lines(issues: readonly Issue[]): string[] {
  return issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`);
}

function issuesOf(schema: Schema<unknown, unknown>, value: unknown): Issue[] {
  const result = schema.safeParse(value);
  return result.success ? [] : [...result.error.issues];
}

const questionIssues = (value: unknown) => issuesOf(QuestionSchema, value);

const ok = { type: "noul", instructions: "Urgent?" };

Deno.test("a well-formed request has no issues", () => {
  assertEquals(
    requestIssues({
      state: { ticket: { subject: "Refund", messages: ["a", "b"] } },
      questions: {
        urgent: {
          type: "noul",
          instructions: "Urgent?",
          criteria: { true: "Now" },
        },
        team: {
          type: "choice",
          instructions: { question: "Which?", context: [1, 2] },
          criteria: { billing: { covers: ["refunds"] }, other: null },
        },
        mood: {
          type: "score",
          instructions: "Mood?",
          criteria: ["Calm", null, { level: 2 }],
        },
      },
    }, "jev-latest"),
    [],
  );
});

Deno.test("every problem is reported at once, with paths", () => {
  const issues = requestIssues({
    state: undefined,
    questions: {
      "": ok,
      blank: { type: "noul", instructions: "" },
      typo: { type: "noul", instructions: "q", critera: {} },
      kind: { type: "multiple", instructions: "q" },
      choice: {
        type: "choice",
        instructions: "q",
        criteria: { " ": null, a: "" },
      },
      score: { type: "score", instructions: "q", criteria: ["one"] },
    },
  }, " ");
  assertEquals(lines(issues), [
    "model: must not be blank",
    "state: state is required",
    'questions[""]: invalid key: question ids must not be empty',
    "questions.blank.instructions: must not be blank",
    'questions.typo.critera: unrecognized key: "critera"',
    'questions.kind.type: unknown type; expected "noul" | "choice" | "score"',
    'questions.choice.criteria[" "]: invalid key: option names must not be blank',
    "questions.choice.criteria.a: must not be blank; use null for no description",
    "questions.score.criteria: a Score needs at least 2 levels",
  ]);
});

Deno.test("fields other than model, state and questions are refused", () => {
  assertEquals(
    lines(requestIssues({ state: "s", questions: { q: ok }, extra: 1 }, "m")),
    ['extra: unrecognized key: "extra"'],
  );
});

Deno.test("questions must exist and be an object", () => {
  assertEquals(lines(requestIssues({ state: "s", questions: {} }, "m")), [
    "questions: ask at least one question",
  ]);
  assertEquals(
    requestIssues({ state: "s", questions: [ok] }, "m")[0].message,
    "expected object, received array",
  );
  assertEquals(paths(requestIssues({ state: "s" }, "m")), ["questions"]);
});

Deno.test("state is text or structure, possibly empty, never null", () => {
  const q = { q: ok };
  assertEquals(requestIssues({ state: "", questions: q }, "m"), []);
  assertEquals(requestIssues({ state: {}, questions: q }, "m"), []);
  assertEquals(requestIssues({ state: [], questions: q }, "m"), []);
  assertEquals(
    requestIssues({ state: null, questions: q }, "m")[0].message,
    "must not be null",
  );
  assertEquals(
    requestIssues({ state: 42, questions: q }, "m")[0].message,
    "expected a string, object or array, received number",
  );
});

Deno.test("values that JSON.stringify would silently change are refused", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  const shared = { x: 1 };
  class Point {
    x = 1;
  }
  const state = {
    missing: undefined,
    fn: () => 1,
    nan: Number.NaN,
    inf: Number.POSITIVE_INFINITY,
    big: 1n,
    when: new Date(0),
    map: new Map(),
    point: new Point(),
    holes: [1, , 3],
    cyclic,
    twice: [shared, shared],
    [Symbol("s")]: 1,
    ok: [null, true, "x", 1.5, { deep: [] }],
  };
  assertEquals(lines(issuesOf(StateSchema, state)), [
    ": symbol keys are not JSON",
    "missing: undefined is not JSON; omit the key or use null",
    "fn: a function is not JSON",
    "nan: NaN is not a JSON number",
    "inf: Infinity is not a JSON number",
    "big: a bigint is not JSON",
    "when: a Date is not a plain JSON object",
    "map: a Map is not a plain JSON object",
    "point: a Point is not a plain JSON object",
    "holes[1]: an array hole is not JSON",
    "cyclic.self: cycle: the value contains itself",
  ]);
});

Deno.test("instructions and criteria are checked as deeply as state", () => {
  assertEquals(
    paths(questionIssues({
      type: "choice",
      instructions: { q: "Pick", when: new Date(0) },
      criteria: { a: { examples: [undefined] }, b: null },
    })),
    ["instructions.when", "criteria.a.examples[0]"],
  );
  assertEquals(
    questionIssues({ type: "noul", instructions: {} })[0].message,
    "must not be empty",
  );
  assertEquals(
    questionIssues({ type: "noul", instructions: [] })[0].message,
    "must not be empty",
  );
  assertEquals(paths(questionIssues({ type: "noul" })), ["instructions"]);
});

Deno.test("noul criteria: true and/or false, never empty or null", () => {
  assertEquals(questionIssues({ ...ok, criteria: { false: "No" } }), []);
  assertEquals(questionIssues({ ...ok, criteria: { true: null } }), []);
  assertEquals(
    questionIssues({ ...ok, criteria: {} })[0].message,
    "must describe true or false; omit it for none",
  );
  assertEquals(
    lines(questionIssues({ ...ok, criteria: null })),
    ["criteria: expected object, received null"],
  );
  assertEquals(
    lines(questionIssues({ ...ok, criteria: { true: "y", maybe: "m" } })),
    ['criteria.maybe: unrecognized key: "maybe"'],
  );
});

Deno.test("choice option counts: 1 to 255", () => {
  const options = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, null]));
  const choice = (n: number) => ({
    type: "choice",
    instructions: "q",
    criteria: options(n),
  });
  assertEquals(questionIssues(choice(1)), []);
  assertEquals(questionIssues(choice(255)), []);
  assertEquals(
    questionIssues(choice(256))[0].message,
    "a Choice has at most 255 options, got 256",
  );
  assertEquals(
    questionIssues({ type: "choice", instructions: "q", criteria: ["a"] })[0]
      .message,
    "expected object, received array",
  );
});

Deno.test("score level counts: 2 to 10", () => {
  const score = (n: number) => ({
    type: "score",
    instructions: "q",
    criteria: Array.from({ length: n }, (_, i) => `level ${i}`),
  });
  assertEquals(questionIssues(score(2)), []);
  assertEquals(questionIssues(score(10)), []);
  assertEquals(
    questionIssues(score(1))[0].message,
    "a Score needs at least 2 levels",
  );
  assertEquals(
    questionIssues(score(11))[0].message,
    "a Score has at most 10 levels",
  );
  assertEquals(
    paths(
      questionIssues({
        type: "score",
        instructions: "q",
        criteria: ["a", , "c"],
      }),
    ),
    ["criteria[1]"],
  );
});

Deno.test("the request schema is the body the client sends", () => {
  const body = {
    model: "jev-1.13.0",
    state: "s",
    questions: { q: ok },
  };
  assertEquals(AskRequestSchema.parse(body), body);
});

Deno.test("the client refuses invalid requests without sending", async () => {
  const fetch = fakeFetch(() => jsonResponse({}));
  const client = new JevClient({ apiKey: "k", fetch });
  let error: unknown;
  try {
    await client.ask({
      state: { when: new Date(0) },
      questions: {},
      extra: true,
    } as never);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof JevInvalidRequestError, "invalid request");
  assertEquals(lines(error.issues), [
    "state.when: a Date is not a plain JSON object",
    "questions: ask at least one question",
    'extra: unrecognized key: "extra"',
  ]);
  assertEquals(error.kind, "invalid_request");
  assertEquals(
    error.message,
    'invalid request: state.when: a Date is not a plain JSON object; questions: ask at least one question; extra: unrecognized key: "extra"',
  );
  assertEquals(fetch.calls.length, 0);
});

Deno.test("request and option models must agree", async () => {
  const client = new JevClient({
    apiKey: "k",
    fetch: fakeFetch(() => jsonResponse({})),
  });
  let error: unknown;
  try {
    await client.ask(
      { state: "s", questions: { q: ok } as never, model: "jev-1.13.0" },
      { model: "jev-latest" },
    );
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof JevInvalidRequestError, "disagreement");
  assertEquals(paths(error.issues), ["model"]);
  assertEquals(error.issues[0].code, "custom");
});
