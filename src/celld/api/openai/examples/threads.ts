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
 * Every route needs a bearer JWT access token (HS256, `typ: at+jwt`, issuer
 * `https://auth.example.com`, audience `https://threads.example.com`),
 * checked with `THREADS_JWT_SECRET`. A caller's threads live in a
 * `GptConversations` object of their own, named by an HMAC of the
 * caller's principal key under `THREADS_OWNER_KEY`, so a thread is keyed
 * by who the caller is plus its id: two callers may both have a `t1`, and
 * neither can read or extend the other's. The spec's values of both are
 * for development only; a deployment sets its own as secrets (at least 32
 * bytes each), and real tokens come from its issuer.
 *
 * - `POST /threads/<id>` with `{"message"}` adds a turn and returns the
 *   reply. A caller may keep at most `MAX_THREADS` threads; a new one past
 *   that is a 409, before the model is asked when the cap is already
 *   reached. The cap itself is the save's `maxConversations`, counted in
 *   the same Durable Object transaction as the write, so first posts
 *   racing for the last slot get it once (the others' model calls were
 *   made and paid for).
 * - `GET /threads/<id>` returns the caller's stored thread, or a 404.
 * - `GET /pacer` and `PUT /pacer` read and configure the pacer
 *   (`{"maxConcurrent"?, "minIntervalMs"?, "maxLeaseMs"?,
 *   "unknownResetBlockMs"?}`). The pacer paces the whole subscription for
 *   every caller, so both need the `pacer:admin` scope.
 *
 * Thread ids are 1 to 64 letters, digits, `_` or `-`; the router refuses
 * anything else with a 400 before a Durable Object is touched.
 *
 * A turn loads the thread, waits for the model, and saves the whole thread
 * back only over the version it loaded (`save` with `expectedItems`, a
 * check and write in one transaction). Of two posts to one thread at the
 * same time, the first to save keeps its turn and the other is a 409
 * `conflict` with `retry: true`, never a silently lost turn; its model
 * call was still made and paid for, so a client posts one message at a
 * time and retries after a 409.
 *
 * ```sh
 * buck2 run root//src/celld/api/openai/examples:threads-dev
 * TOKEN=...   # an HS256 at+jwt signed with the development secret; see threads.json
 * curl -sS -X POST localhost:9876/threads/t1 -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"message": "Hi"}'
 * curl -sS localhost:9876/threads/t1 -H "authorization: Bearer $TOKEN"
 * ```
 *
 * @module
 */

import {
  Conversation,
  ConversationConflictError,
  ConversationLimitError,
  type ConversationsApi,
  durableConversationStore,
  durablePacer,
  GptClient,
  type GptEnv,
  type PacerApi,
} from "@celld/api/openai";
import {
  bearer,
  HttpError,
  jwtVerifier,
  type Principal,
  router,
  type TokenVerifier,
} from "@celld/web/router";
import { v } from "@celld/sieve";

export { GptConversations, GptPacer } from "@celld/api/openai/durable";

interface Env extends GptEnv {
  readonly GPT_CONVERSATIONS: DurableObjectNamespace<ConversationsApi>;
  readonly GPT_PACER: DurableObjectNamespace<PacerApi>;
  /** The HS256 key access tokens are signed with. */
  readonly THREADS_JWT_SECRET: string;
  /** The HMAC key that turns a principal into the name of its store. */
  readonly THREADS_OWNER_KEY: string;
}

const INSTRUCTIONS = "You are a patient tutor. Keep answers short.";

/** Threads one caller may keep. */
const MAX_THREADS = 32;

const encoder = new TextEncoder();

function secret(value: unknown, name: string): Uint8Array<ArrayBuffer> {
  const bytes = typeof value === "string" ? encoder.encode(value) : null;
  // Fail closed: a missing or short key is the operator's mistake, an
  // opaque 500, never an open door.
  if (bytes === null || bytes.byteLength < 32) {
    throw new Error(`${name} must be set to at least 32 bytes`);
  }
  return bytes;
}

// One verifier per signing secret, built on first use.
const verifiers = new Map<string, TokenVerifier>();

function verifierFor(env: Env): TokenVerifier {
  const raw = env.THREADS_JWT_SECRET;
  let verify = verifiers.get(raw);
  if (verify === undefined) {
    verify = jwtVerifier({
      keys: secret(raw, "THREADS_JWT_SECRET"),
      algorithms: ["HS256"],
      typ: "at+jwt",
      issuer: "https://auth.example.com",
      audience: "https://threads.example.com",
    });
    verifiers.set(raw, verify);
  }
  return verify;
}

const auth = bearer({
  verify: (request) => verifierFor(request.context.env as Env)(request),
  realm: "threads",
  bearerFormat: "JWT",
});

/**
 * The name of the caller's `GptConversations` object: `threads-` and the
 * hex HMAC-SHA256 of its principal key, so nothing in the request can pick
 * another caller's threads.
 */
async function ownerStore(env: Env, principal: Principal | null) {
  if (principal === null) throw new HttpError(401);
  const key = await crypto.subtle.importKey(
    "raw",
    secret(env.THREADS_OWNER_KEY, "THREADS_OWNER_KEY"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(principal.key)),
  );
  return `threads-${
    [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

const Thread = v.object({ id: v.string().regex(/^[\w-]{1,64}$/) });

const Ms = v.int().min(0);

const PacerSettings = v.strictObject({
  maxConcurrent: v.int().min(1).optional(),
  minIntervalMs: Ms.optional(),
  maxLeaseMs: v.int().min(1).optional(),
  unknownResetBlockMs: Ms.optional(),
});

const app = router<Env>({ auth, limits: { maxTimeout: 600 } });

app.post("/threads/:id", {
  params: Thread,
  body: v.strictObject({ message: v.string().trim().min(1) }),
  limits: { timeout: 600 },
}, async (c) => {
  const { id } = c.params;
  const name = await ownerStore(c.env, c.principal);
  const store = durableConversationStore(c.env.GPT_CONVERSATIONS, name);
  const stored = await store.load(id);
  // An early answer before a model call is paid for; the save below is
  // what enforces the cap.
  if (
    stored === null &&
    (await c.env.GPT_CONVERSATIONS.getByName(name).list(MAX_THREADS))
        .length >= MAX_THREADS
  ) {
    throw new HttpError(409, `at most ${MAX_THREADS} threads per caller`);
  }
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
  // Only over the version loaded: a concurrent message to the same thread
  // that saved first makes this one a 409, never a lost turn. A new thread
  // past the caller's quota is refused in the same transaction.
  try {
    await store.save(thread.toJSON(), {
      expectedItems: stored?.items.length ?? null,
      maxConversations: MAX_THREADS,
    });
  } catch (error) {
    if (error instanceof ConversationConflictError) {
      return c.json({ error: "conflict", retry: true }, 409);
    }
    if (error instanceof ConversationLimitError) {
      throw new HttpError(409, `at most ${MAX_THREADS} threads per caller`);
    }
    throw error;
  }
  return c.json({
    reply: outcome.result.finalText,
    turns: thread.toJSON().turns,
  });
});

app.get("/threads/:id", { params: Thread }, async (c) => {
  const stored = await durableConversationStore(
    c.env.GPT_CONVERSATIONS,
    await ownerStore(c.env, c.principal),
  ).load(c.params.id);
  if (stored === null) throw new HttpError(404, "no such thread");
  return c.json({
    id: stored.id,
    turns: stored.turns,
    usage: stored.usage,
    items: stored.items.map((item) => item.type),
  });
});

// The pacer is shared by every caller of the subscription: operators only.
app.get(
  "/pacer",
  { scopes: ["pacer:admin"] },
  async (c) => c.json(await c.env.GPT_PACER.getByName("default").snapshot()),
);

app.put(
  "/pacer",
  { scopes: ["pacer:admin"], body: PacerSettings },
  async (c) =>
    c.json(await c.env.GPT_PACER.getByName("default").configure(c.body)),
);

export default { fetch: app.fetch };
