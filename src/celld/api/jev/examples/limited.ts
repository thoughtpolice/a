// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Review sentiment with a fleet-wide rate limiter and the KV answer cache.
 *
 * `POST /sentiment` with `{"text"}` asks one Noul. Every request first asks
 * a `durableLimiter` over `@celld/sec/ratelimit`'s `RateLimitShard` Durable
 * Objects for admission, so all Workers sharing an API key stay under
 * TypeSafe's limits together, and a 429's `retry-after` holds all of them,
 * not only the one refused. The limits are Jev's documented ones, or those
 * in the `JEV_LIMITS` var (JSON, checked by a sieve schema; the spec sets
 * it). Answers are cached in KV under a hash of model, state and questions;
 * the cache only works for a pinned model, since an alias such as
 * `jev-latest` can change what it means. `meta.cache` says whether the
 * answer was a `hit`. The KV entry is a cache, not a claim: two requests
 * that miss together both ask, and every Worker bound to the namespace
 * trusts what is in it.
 *
 * `GET /limits` reads the limiter: whether a request would be admitted now,
 * how long until it would, and each policy's remaining units. Both routes
 * are deliberately unauthenticated, for the demo: any caller spends the
 * TypeSafe key's quota and reads the limiter's state. A failed question is
 * a 502 with only the error's kind, and bodies over 64 KiB are a 413.
 *
 * ```sh
 * buck2 run root//src/celld/api/jev/examples:limited-dev
 * curl -sS -X POST localhost:9876/sentiment -H 'content-type: application/json' \
 *   -d '{"text": "Great product"}'
 * curl -sS localhost:9876/limits
 * ```
 *
 * @module
 */

import { JevClient, type JevEnv, jevPolicies, noul } from "@celld/api/jev";
import { kvCache } from "@celld/api/jev/cache";
import {
  durableLimiter,
  type RateLimiter,
  type RateLimitShardApi,
} from "@celld/sec/ratelimit";
import { router } from "@celld/web/router";
import { v } from "@celld/sieve";

export { RateLimitShard } from "@celld/sec/ratelimit/durable";

interface Env extends JevEnv {
  readonly RATE_LIMITS: DurableObjectNamespace<RateLimitShardApi>;
  readonly JEV_CACHE: KVNamespace;
  /** Limits over Jev's documented ones, as JSON. A var. */
  readonly JEV_LIMITS?: string;
}

const Limits = v.strictObject({
  requestsPerMinute: v.int().positive().optional(),
  requestBurst: v.int().positive().optional(),
  tokensPerSecond: v.int().positive().max(1_000_000).optional(),
  tokenBurst: v.int().positive().optional(),
});

/** The limiter every Worker on the API key shares. */
function limiter(env: Env): RateLimiter {
  const limits = env.JEV_LIMITS === undefined
    ? {}
    : Limits.parse(JSON.parse(env.JEV_LIMITS));
  return durableLimiter(env.RATE_LIMITS, {
    name: "jev",
    policies: jevPolicies(limits),
  });
}

const positive = noul("Is this review positive about the product?");

function client(env: Env): JevClient {
  return JevClient.fromEnv(env, {
    model: "jev-1.13.0",
    limiter: limiter(env),
    cache: kvCache(env.JEV_CACHE, { ttlSeconds: 86_400 }),
    // Asking about a review twice costs a second evaluation and nothing
    // else, so asks may be retried after a 429 or 5xx.
    idempotentAsks: true,
  });
}

const Review = v.object({
  text: v.string().regex(/\S/, "must not be blank").max(10_000),
});

const app = router<Env>({ auth: "none", limits: { body: 64 * 1024 } });

// Deliberately unauthenticated: any caller spends the TypeSafe key's quota.
app.post("/sentiment", { public: true, body: Review }, async (c) => {
  const outcome = await client(c.env).tryAsk({
    state: c.body.text,
    questions: { positive },
  });
  if (!outcome.ok) {
    // Callers get the kind only; TypeSafe's text stays in the log.
    console.error("jev failed:", outcome.error.message);
    return c.json({ error: "upstream_error", kind: outcome.error.kind }, 502);
  }
  const { answers, meta } = outcome.result;
  return c.json({
    positive: answers.positive.noul,
    cache: meta.cache,
    attempts: meta.attempts,
  });
});

// Deliberately unauthenticated: any caller reads the limits and whether
// the key is being held back.
app.get(
  "/limits",
  { public: true },
  async (c) => c.json(await limiter(c.env).peek("default", { cost: 0 })),
);

export default { fetch: app.fetch };
