// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable chat threads, paced across the whole fleet.
 *
 * The backend stores nothing (`store: false`), so a conversation is its
 * items, replayed in full each turn. `GptConversations` keeps them: one
 * SQLite row per item in a Durable Object, reasoning items included with
 * their `encrypted_content`, which is the only way the model sees its own
 * earlier reasoning. The thread id is the prompt cache key, so every turn
 * of a thread shares a cache and the replayed prefix is billed as cached.
 *
 * Every call also goes through `GptPacer`, one Durable Object per
 * subscription: it caps concurrent calls, and after a usage limit it holds
 * every caller until the reset (durably, across restarts) instead of
 * letting each find out with a failed request.
 *
 * - `POST /threads/<id>` with `{"message"}` adds a turn and returns the reply.
 * - `GET /threads/<id>` returns the stored thread.
 * - `GET /pacer` and `PUT /pacer` read and configure the pacer
 *   (`{"maxConcurrent"?, "minIntervalMs"?, "maxLeaseMs"?,
 *   "unknownResetBlockMs"?}`).
 *
 * Thread ids are 1 to 64 letters, digits, `_` or `-`; the router refuses
 * anything else with a 400 before a Durable Object is touched.
 *
 * ```sh
 * buck2 run root//src/celld/api/openai/examples:threads-dev
 * curl -sS -X POST localhost:9876/threads/t1 -H 'content-type: application/json' -d '{"message": "Hi"}'
 * curl -sS localhost:9876/threads/t1
 * ```
 *
 * @module
 */

import {
  Conversation,
  type ConversationsApi,
  durableConversationStore,
  durablePacer,
  GptClient,
  type GptEnv,
  type PacerApi,
} from "@celld/api/openai";
import { HttpError, router } from "@celld/router";
import { v } from "@celld/sieve";

export { GptConversations, GptPacer } from "@celld/api/openai/durable";

interface Env extends GptEnv {
  readonly GPT_CONVERSATIONS: DurableObjectNamespace<ConversationsApi>;
  readonly GPT_PACER: DurableObjectNamespace<PacerApi>;
}

const INSTRUCTIONS = "You are a patient tutor. Keep answers short.";

const Thread = v.object({ id: v.string().regex(/^[\w-]{1,64}$/) });

const Ms = v.int().min(0);

const PacerSettings = v.strictObject({
  maxConcurrent: v.int().min(1).optional(),
  minIntervalMs: Ms.optional(),
  maxLeaseMs: v.int().min(1).optional(),
  unknownResetBlockMs: Ms.optional(),
});

const app = router<Env>({ auth: "none" });

app.post("/threads/:id", {
  params: Thread,
  body: v.strictObject({ message: v.string().trim().min(1) }),
  limits: { timeout: 600 },
}, async (c) => {
  const { id } = c.params;
  const store = durableConversationStore(c.env.GPT_CONVERSATIONS, "threads");
  const stored = await store.load(id);
  const thread = stored === null
    ? new Conversation({ id, instructions: INSTRUCTIONS })
    : Conversation.fromJSON(stored);
  thread.user(c.body.message);
  const gpt = GptClient.fromEnv(c.env, {
    pacer: durablePacer(c.env.GPT_PACER),
  });
  const outcome = await gpt.tryRespond(thread.request(), { signal: c.signal });
  if (!outcome.ok) {
    const { kind, message } = outcome.error;
    return c.json({ kind, error: message }, 502);
  }
  thread.record(outcome.result);
  await store.save(thread.toJSON());
  return c.json({
    reply: outcome.result.finalText,
    turns: thread.toJSON().turns,
  });
});

app.get("/threads/:id", { params: Thread }, async (c) => {
  const stored = await durableConversationStore(
    c.env.GPT_CONVERSATIONS,
    "threads",
  ).load(c.params.id);
  if (stored === null) throw new HttpError(404, "no such thread");
  return c.json({
    id: stored.id,
    turns: stored.turns,
    usage: stored.usage,
    items: stored.items.map((item) => item.type),
  });
});

app.get(
  "/pacer",
  async (c) => c.json(await c.env.GPT_PACER.getByName("default").snapshot()),
);

app.put(
  "/pacer",
  { body: PacerSettings },
  async (c) =>
    c.json(await c.env.GPT_PACER.getByName("default").configure(c.body)),
);

export default { fetch: app.fetch };
