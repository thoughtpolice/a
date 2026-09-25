// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A chat endpoint, whole or streamed.
 *
 * `POST /chat` with `{"message"}` answers `{"text", "model", "usage"}` once
 * the model is done; a body without a non-blank `message` is a 400 from the
 * router, before any call. With `"stream": true` it answers with server-sent
 * events instead, passing the model's text through as it arrives:
 * `event: delta` for each piece, `event: retry` when a transient failure
 * made the client start over (discard what you showed), then
 * `event: done` with the usage, or `event: error`.
 *
 * `GptClient.fromEnv(env)` talks to the exe.dev LLM integration at
 * `https://llm.int.exe.xyz/openai/v1`, which adds the ChatGPT account's
 * credentials at its edge: the Worker holds no key. `OPENAI_BASE_URL`
 * overrides it, which is how the fake gets in.
 *
 * ```sh
 * buck2 run root//src/celld/api/openai/examples:chat-dev
 * curl -sS -X POST localhost:9876/chat -H 'content-type: application/json' -d '{"message": "Hello"}'
 * curl -sSN -X POST localhost:9876/chat -H 'content-type: application/json' -d '{"message": "Hello", "stream": true}'
 * ```
 *
 * @module
 */

import { GptClient, type GptEnv, type GptError } from "@celld/api/openai";
import { router } from "@celld/router";
import { v } from "@celld/sieve";

const INSTRUCTIONS = "You are a concise assistant. Answer in plain text.";

const Chat = v.strictObject({
  message: v.string().trim().min(1),
  stream: v.boolean().default(false),
});

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

function streamed(gpt: GptClient, message: string): Response {
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  (async () => {
    try {
      const stream = gpt.stream({ input: message, instructions: INSTRUCTIONS });
      for await (const event of stream) {
        if (event.type === "text.delta") {
          await writer.write(sse("delta", { text: event.delta }));
        } else if (event.type === "retry") {
          await writer.write(sse("retry", {}));
        }
      }
      const turn = await stream.result;
      await writer.write(sse("done", { usage: turn.usage }));
    } catch (error) {
      const { kind, message } = (error as GptError).toJSON();
      await writer.write(sse("error", { kind, message }));
    } finally {
      await writer.close();
    }
  })();
  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

const app = router<GptEnv>({ auth: "none" });

// A high-effort answer can take minutes; the stream is not cut off anyway,
// since the budget ends when the response starts.
app.post("/chat", { body: Chat, limits: { timeout: 600 } }, async (c) => {
  const { message, stream } = c.body;
  const gpt = GptClient.fromEnv(c.env);
  if (stream) return streamed(gpt, message);
  const outcome = await gpt.tryRespond({
    input: message,
    instructions: INSTRUCTIONS,
    reasoning: { effort: "low" },
  }, { signal: c.signal });
  if (!outcome.ok) {
    const { kind, message } = outcome.error;
    return c.json({ kind, error: message }, 502);
  }
  const turn = outcome.result;
  return c.json({
    text: turn.finalText,
    model: turn.servedModel ?? turn.model,
    usage: turn.usage,
  });
});

export default { fetch: app.fetch };
