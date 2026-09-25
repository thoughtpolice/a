// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Review sentiment with the fleet-wide rate limiter and the KV answer cache.
 *
 * `POST /sentiment` with `{"text"}` asks one Noul. Every request first asks
 * the `JevRateLimiter` Durable Object for admission, so all Workers sharing
 * an API key stay under TypeSafe's limits together, and a 429's
 * `retry-after` holds all of them, not only the one refused. Answers are
 * cached in KV under a hash of model, state and questions; the cache only
 * works for a pinned model, since an alias such as `jev-latest` can change
 * what it means. `meta.cache` says whether the answer was a `hit`.
 *
 * `GET /limits` reads the limiter and `PUT /limits` changes its limits,
 * which it stores durably. Both bodies are checked by sieve schemas in the
 * router before a handler runs. The routes are public for the demo; a real
 * deployment would put `PUT /limits` behind an auth scheme.
 *
 * ```sh
 * buck2 run root//src/celld/api/jev/examples:limited-dev
 * curl -sS -X POST localhost:9876/sentiment -H 'content-type: application/json' \
 *   -d '{"text": "Great product"}'
 * curl -sS -X PUT localhost:9876/limits -H 'content-type: application/json' \
 *   -d '{"requestsPerMinute": 60}'
 * ```
 *
 * @module
 */

import { JevClient, type JevEnv, noul } from "@celld/api/jev";
import { kvCache } from "@celld/api/jev/cache";
import { durableLimiter, type RateLimiterApi } from "@celld/api/jev/limiter";
import { router } from "@celld/router";
import { v } from "@celld/sieve";

export { JevRateLimiter } from "@celld/api/jev/durable";

interface Env extends JevEnv {
  readonly JEV_LIMITER: DurableObjectNamespace<RateLimiterApi>;
  readonly JEV_CACHE: KVNamespace;
}

const positive = noul("Is this review positive about the product?");

function client(env: Env): JevClient {
  return JevClient.fromEnv(env, {
    model: "jev-1.13.0",
    limiter: durableLimiter(env.JEV_LIMITER),
    cache: kvCache(env.JEV_CACHE, { ttlSeconds: 86_400 }),
  });
}

const Review = v.object({
  text: v.string().regex(/\S/, "must not be blank").max(10_000),
});

const Limits = v.strictObject({
  requestsPerMinute: v.number().positive().optional(),
  requestBurst: v.number().min(1).optional(),
  tokensPerSecond: v.number().positive().optional(),
  tokenBurst: v.number().positive().optional(),
});

const app = router<Env>({ auth: "none" });

app.post("/sentiment", { public: true, body: Review }, async (c) => {
  const outcome = await client(c.env).tryAsk({
    state: c.body.text,
    questions: { positive },
  });
  if (!outcome.ok) return c.json(outcome.error, 502);
  const { answers, meta } = outcome.result;
  return c.json({
    positive: answers.positive.noul,
    cache: meta.cache,
    attempts: meta.attempts,
  });
});

app.get(
  "/limits",
  { public: true },
  async (c) => c.json(await c.env.JEV_LIMITER.getByName("default").snapshot()),
);

app.put(
  "/limits",
  { public: true, body: Limits },
  async (c) =>
    c.json(await c.env.JEV_LIMITER.getByName("default").configure(c.body)),
);

export default { fetch: app.fetch };
