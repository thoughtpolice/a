// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Test doubles for code that uses `@celld/api/jev`: well-formed answers for any
 * questions, a recording `fetch`, and (from `@celld/http/testing`) a virtual
 * clock that sleeps instantly. No network and no API key are involved.
 *
 * ```ts
 * const fetch = fakeFetch(({ body }) =>
 *   jsonResponse(fakeBody(body.questions, { answers: { urgent: { noul: 0.9 } } }))
 * );
 * const client = new JevClient({ apiKey: "test", fetch, runtime: virtualRuntime() });
 * ```
 *
 * @module
 */

import type { FetchLike } from "@celld/http";
import type { JsonValue } from "./json.ts";
import type { Answer, Question, Questions } from "./types.ts";

export { type VirtualRuntime, virtualRuntime } from "@celld/http/testing";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A certain answer to a question: yes for a Noul, the first option for a
 * Choice, the lowest level for a Score, each with confidence 1.
 */
export function answerFor(question: Question): Answer {
  switch (question.type) {
    case "noul":
      return { type: "noul", noul: 1 };
    case "choice": {
      const options = Object.keys(question.criteria);
      return {
        type: "choice",
        choice: options[0],
        probabilities: Object.fromEntries(
          options.map((option, index) => [option, index === 0 ? 1 : 0]),
        ),
        confidence: 1,
      };
    }
    case "score": {
      const levels = question.criteria;
      return {
        type: "score",
        score: 0,
        legend: Object.fromEntries(
          levels.map((
            level,
            index,
          ) => [String(index), (level ?? "") as JsonValue]),
        ),
        probabilities: Object.fromEntries(
          levels.map((_, index) => [String(index), index === 0 ? 1 : 0]),
        ),
        confidence: 1,
      } as Answer;
    }
  }
}

/** Overrides for {@link fakeBody}. */
export interface FakeBodyOptions {
  /** The `model` reported; default `jev-1.13.0`. */
  readonly model?: string;
  /** Fields merged over each id's generated answer. */
  readonly answers?: { readonly [id: string]: Record<string, unknown> };
  /** The usage reported; default 100 input and 10 output tokens. */
  readonly usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
}

/**
 * A response body answering every question in `questions`, which may be the
 * parsed request body's `questions`.
 */
export function fakeBody(
  questions: unknown,
  options: FakeBodyOptions = {},
): Record<string, JsonValue> {
  if (!isPlainObject(questions)) {
    throw new TypeError("fakeBody needs the questions object");
  }
  const answers: Record<string, JsonValue> = {};
  for (const [id, question] of Object.entries(questions as Questions)) {
    answers[id] = {
      ...answerFor(question),
      ...options.answers?.[id],
    } as JsonValue;
  }
  return {
    model: options.model ?? "jev-1.13.0",
    answers,
    usage: {
      ...(options.usage ?? { input_tokens: 100, output_tokens: 10 }),
    },
  };
}

/** A JSON response with the given status and headers. */
export function jsonResponse(
  body: unknown,
  init: {
    readonly status?: number;
    readonly headers?: Record<string, string>;
  } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/** One request a {@link fakeFetch} received. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  /** The parsed JSON body, or undefined for none. */
  // deno-lint-ignore no-explicit-any
  readonly body: any;
  readonly signal: AbortSignal | null;
}

/** A `fetch` that answers from a handler and records every request. */
export type FakeFetch = FetchLike & { readonly calls: RecordedRequest[] };

/**
 * A `fetch` that hands each request, with its body parsed, to `handler`
 * together with its zero-based index. Throwing from the handler is how to
 * fake a connection failure.
 */
export function fakeFetch(
  handler: (
    request: RecordedRequest,
    index: number,
  ) => Response | Promise<Response>,
): FakeFetch {
  const calls: RecordedRequest[] = [];
  const fake = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    // The clients pass a URL string and an init; a Request's own body is
    // not read, only its URL, method and headers.
    const from = input instanceof Request ? input : undefined;
    const text = typeof init.body === "string" ? init.body : undefined;
    const request: RecordedRequest = {
      url: from?.url ?? String(input),
      method: init.method ?? from?.method ?? "GET",
      headers: new Headers(init.headers ?? from?.headers),
      body: text === undefined ? undefined : JSON.parse(text),
      signal: init.signal ?? null,
    };
    calls.push(request);
    return await handler(request, calls.length - 1);
  };
  return Object.assign(fake, { calls });
}
