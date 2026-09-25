// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Prototype names as option and question ids: WP-12b sweep regressions.

import { assert, assertEquals } from "@celld/core/assert";
import { choice, type ChoiceAnswer, gateChoice } from "@celld/api/jev";
import { fakeBody } from "@celld/api/jev/testing";

/**
 * Runs `body` with `Object.prototype.__proto__` as V8 (and so workerd)
 * defines it. Deno removes the accessor by default, which hides assignments
 * that would change an object's prototype in a Worker.
 */
function withProtoAccessor(body: () => void): void {
  const had = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__");
  Object.defineProperty(Object.prototype, "__proto__", {
    configurable: true,
    enumerable: false,
    get(this: object) {
      return Object.getPrototypeOf(this);
    },
    set(this: object, proto: unknown) {
      if (typeof proto === "object" || typeof proto === "function") {
        Object.setPrototypeOf(this, proto as object | null);
      }
    },
  });
  try {
    body();
  } finally {
    if (had === undefined) {
      delete (Object.prototype as { __proto__?: unknown }).__proto__;
    } else {
      Object.defineProperty(Object.prototype, "__proto__", had);
    }
  }
}

function answer(option: string, confidence: number): ChoiceAnswer<string> {
  return {
    type: "choice",
    choice: option,
    probabilities: { [option]: confidence },
    confidence,
  };
}

// DB-SWP-F9-301: the act bar was a plain lookup, so an option named after
// an Object.prototype member got that member (a function) as its bar and
// could never reach "act".
Deno.test("gateChoice ignores inherited bars", () => {
  for (const option of ["constructor", "toString", "valueOf"]) {
    assertEquals(
      gateChoice(answer(option, 0.95), { floor: 0.5 }).decision,
      "act",
      option,
    );
    assertEquals(
      gateChoice(answer(option, 0.95), { floor: 0.5, act: { other: 0.9 } })
        .decision,
      "act",
      option,
    );
  }
  assertEquals(
    gateChoice(answer("constructor", 0.7), {
      floor: 0.5,
      act: { constructor: 0.9 } as Record<string, number>,
    }).decision,
    "review",
  );
});

// DB-SWP-F9-302: `choice(q, [...])` wrote options into `{}` by assignment,
// so `__proto__` set the criteria's prototype instead of adding an option.
Deno.test("choice keeps an option named __proto__", () =>
  withProtoAccessor(() => {
    const question = choice("Pick one", ["__proto__", "x"]);
    const criteria = question.criteria as Record<string, unknown>;
    assertEquals(Object.keys(criteria), ["__proto__", "x"]);
    assertEquals(Object.getPrototypeOf(criteria), Object.prototype);
    let duplicate = false;
    try {
      choice("Pick one", ["__proto__", "__proto__"]);
    } catch {
      duplicate = true;
    }
    assert(duplicate, "a repeated __proto__ is a duplicate");
  }));

// DB-SWP-F9-303: the fake filled its answers with `answers[id] =`, so a
// question id `__proto__` set a prototype instead of being answered.
Deno.test("fakeBody answers a question id __proto__", () =>
  withProtoAccessor(() => {
    const questions = JSON.parse(
      '{"__proto__":{"type":"noul","instructions":"q","criteria":{"true":"yes"}}}',
    );
    const body = fakeBody(questions);
    const answers = body.answers as Record<string, unknown>;
    assert(Object.hasOwn(answers, "__proto__"), "answered");
    assertEquals(Object.getPrototypeOf(answers), Object.prototype);
    assertEquals(answers["__proto__"], { type: "noul", noul: 1 });
  }));
