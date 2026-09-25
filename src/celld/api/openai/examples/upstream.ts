// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The fake integration the openai examples run against.
 *
 * `/openai/v1/responses` and `/openai/v1/models` are `FakeResponses` from
 * `@celld/api/openai/testing`, which streams each scripted turn as the Codex
 * backend does: `response.created`, each output item's events, then
 * `response.completed` with usage. A request with nothing scripted gets a
 * turn that echoes the last user message, so `curl` works without a script.
 * `/v1/systemone` is the jev examples' fake TypeSafe server, for the Jev
 * bridge.
 *
 * `script` entries:
 *
 * - `{"turn": TurnSpec}` queues a response (text, reasoning with its
 *   encrypted content, tool calls, usage, a failure; see `TurnSpec`);
 * - `{"error": {"status": 429, "body": {...}, "headers": {...}}}` queues a
 *   plain HTTP error instead;
 * - `{"jev": Reply}` queues a TypeSafe reply (see `@celld/api/jev/examples/fake`).
 *
 * It sets `OPENAI_BASE_URL` to its `/openai/v1`, which `GptClient.fromEnv`
 * prefers over the `llm.int.exe.xyz` integration, and `TYPESAFE_BASE_URL`
 * and `TYPESAFE_API_KEY` for `JevClient.fromEnv`.
 *
 * @module
 */

import {
  API_KEY,
  FakeTypeSafe,
  type Reply,
} from "@celld/api/jev/examples/fake";
import {
  FakeResponses,
  jsonResponse,
  type RecordedRequest,
  type TurnSpec,
} from "@celld/api/openai/testing";
import { serveUpstream } from "@celld/examples/upstream";

interface Instruction {
  readonly turn?: TurnSpec;
  readonly error?: {
    readonly status: number;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  };
  readonly jev?: Reply;
}

function lastUserText(request: RecordedRequest): string {
  const items = (request.body?.input ?? []) as {
    type?: string;
    role?: string;
    content?: { type: string; text?: string }[];
  }[];
  for (const item of [...items].reverse()) {
    if (item.type === "message" && item.role === "user") {
      return item.content?.find((part) => part.type === "input_text")?.text ??
        "";
    }
  }
  return "";
}

const responses = new FakeResponses();
const typesafe = new FakeTypeSafe();

serveUpstream({
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/systemone") return await typesafe.fetch(request);
    if (request.method === "POST" && responses.remaining === 0) {
      responses.push((recorded) => ({
        text: `echo: ${lastUserText(recorded)}`,
      }));
    }
    const body = await request.text();
    return await responses.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: body === "" ? undefined : body,
    });
  },
  script(instruction) {
    const { turn, error, jev } = instruction as Instruction;
    if (turn !== undefined) responses.push(turn);
    if (error !== undefined) {
      responses.push(() =>
        jsonResponse(error.body ?? { error: { message: "scripted failure" } }, {
          status: error.status,
          headers: error.headers,
        })
      );
    }
    if (jev !== undefined) typesafe.script(jev);
  },
  vars: (origin) => ({
    OPENAI_BASE_URL: `${origin}/openai/v1`,
    TYPESAFE_BASE_URL: origin,
    TYPESAFE_API_KEY: API_KEY,
  }),
});
