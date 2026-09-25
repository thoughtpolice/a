// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/jev/examples/fake`: a scriptable stand-in for TypeSafe's
 * `POST /v1/systemone`, for example upstreams. The jev examples serve it
 * alone (`upstream.ts`); others, such as the openai Jev bridge example,
 * serve it beside their own fake.
 *
 * Unscripted requests are answered by `fakeBody` from `@celld/api/jev/testing`:
 * yes for a Noul, the first option for a Choice and the lowest level for a
 * Score, all with confidence 1. {@link FakeTypeSafe.script} queues the next
 * replies, one per request:
 *
 * - `{"answers": {"team": {"choice": "technical", "confidence": 0.8}}}`
 *   overrides answers. A Choice given only `choice` gets that option at its
 *   `confidence` (default 1) and the rest shared evenly; a Score given only
 *   `score` gets all its probability on that level. Anything else is merged
 *   over the generated answer as it is.
 * - `{"status": 429, "headers": {"retry-after": "1"}}` answers with an
 *   error instead (`body` optional).
 *
 * @module
 */

import type { Question, Questions } from "@celld/api/jev";
import { fakeBody, jsonResponse } from "@celld/api/jev/testing";

/** One scripted reply; see the module notes. */
export interface Reply {
  readonly answers?: Record<string, Record<string, unknown>>;
  readonly model?: string;
  readonly usage?: { input_tokens: number; output_tokens: number };
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

/** The key the fake expects, as `TYPESAFE_API_KEY`. */
export const API_KEY = "example-key";

function spread(
  keys: readonly string[],
  chosen: string,
  confidence: number,
): Record<string, number> {
  const rest = keys.length > 1 ? (1 - confidence) / (keys.length - 1) : 0;
  return Object.fromEntries(
    keys.map((key) => [key, key === chosen ? confidence : rest]),
  );
}

function expand(
  question: Question,
  override: Record<string, unknown>,
): Record<string, unknown> {
  if ("probabilities" in override) return override;
  if (question.type === "choice" && typeof override.choice === "string") {
    const confidence = (override.confidence as number | undefined) ?? 1;
    const options = Object.keys(question.criteria);
    return {
      confidence,
      ...override,
      probabilities: spread(options, override.choice, confidence),
    };
  }
  if (question.type === "score" && typeof override.score === "number") {
    const levels = question.criteria.map((_, index) => String(index));
    return {
      confidence: 1,
      ...override,
      probabilities: spread(levels, String(override.score), 1),
    };
  }
  return override;
}

/** A fake TypeSafe server's request handling; see the module notes. */
export class FakeTypeSafe {
  readonly #queue: Reply[] = [];
  #served = 0;

  /** Queues the reply to the next request. */
  script(reply: Reply): void {
    this.#queue.push(reply);
  }

  /** Answers `POST /v1/systemone`; anything else is a 404. */
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/v1/systemone") {
      return jsonResponse({ detail: "not found" }, { status: 404 });
    }
    if (request.headers.get("authorization") !== `Bearer ${API_KEY}`) {
      return jsonResponse({ detail: "invalid api key" }, { status: 401 });
    }
    const { questions } = await request.json() as { questions: Questions };
    const reply = this.#queue.shift() ?? {};
    const headers = { "x-typesafe-request-id": `req-${++this.#served}` };
    if (reply.status !== undefined) {
      return jsonResponse(reply.body ?? { detail: "scripted failure" }, {
        status: reply.status,
        headers: { ...headers, ...reply.headers },
      });
    }
    const answers = Object.fromEntries(
      Object.entries(reply.answers ?? {}).map((
        [id, override],
      ) => [
        id,
        questions[id] === undefined
          ? override
          : expand(questions[id], override),
      ]),
    );
    return jsonResponse(
      fakeBody(questions, { model: reply.model, usage: reply.usage, answers }),
      { headers },
    );
  }
}
