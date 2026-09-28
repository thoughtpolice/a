// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Quotas for an API: a per-address limit on everything, and per-key
 * quotas with two policies, charged by what each route costs.
 *
 * - Every request, 404s and refused credentials included, is charged to
 *   its address first (`app.use`, 60 a minute): a client guessing keys
 *   spends its own address's budget.
 * - Each API key's requests are charged after authentication (a route's
 *   `use`), to the principal's `key`: 4 units a minute and 6 a day, both at
 *   once, so a burst is capped by the minute and a steady trickle by the
 *   day. A refusal by either spends nothing from the other.
 * - `GET /reports` costs 1 unit, `POST /exports` 3.
 *
 * Every admitted answer carries `RateLimit-Policy` and `RateLimit` with
 * each policy charged (the address and the key's two); a refusal is a 429
 * with `Retry-After`.
 *
 * `API_KEYS` maps SHA-256 hashes of keys (`hashApiKey`) to principals; it
 * is a secret, set by the spec's `vars` for `celld dev`. Unset, every key
 * is refused. The address is `CF-Connecting-IP`, trustworthy only on
 * Cloudflare's edge (see the `login` example).
 *
 * ```sh
 * buck2 run root//src/celld/sec/ratelimit/examples:api-dev
 * curl -sS -i localhost:9876/reports -H 'x-api-key: example-key-alice'
 * ```
 *
 * @module
 */

import {
  durableLimiter,
  type RateLimiter,
  type RateLimitShardApi,
} from "@celld/sec/ratelimit";
import { byIp, byPrincipal, rateLimit } from "@celld/sec/ratelimit/router";
import {
  apiKey,
  hashedKeys,
  type PrincipalInput,
  router,
} from "@celld/web/router";
import { v } from "@celld/sieve";

export { RateLimitShard } from "@celld/sec/ratelimit/durable";

interface Env {
  readonly RATE_LIMITS: DurableObjectNamespace<RateLimitShardApi>;
  /** `{"<sha256 of key>": {"subject": ...}}` */
  readonly API_KEYS?: string;
}

function build(env: Env) {
  const table: Record<string, PrincipalInput> = env.API_KEYS === undefined
    ? {}
    : JSON.parse(env.API_KEYS);
  const perAddress: RateLimiter = durableLimiter(env.RATE_LIMITS, {
    name: "api-address",
    policies: [{ name: "address", limit: 60, window: "PT1M" }],
  });
  const perKey: RateLimiter = durableLimiter(env.RATE_LIMITS, {
    name: "api-key",
    policies: [
      { name: "minute", limit: 4, window: "PT1M" },
      { name: "day", limit: 6, window: "P1D" },
    ],
  });
  const charge = (cost: number) =>
    rateLimit({ limiter: perKey, key: byPrincipal(), cost });

  const app = router<Env>({ auth: apiKey({ lookup: hashedKeys(table) }) })
    .use(rateLimit({ limiter: perAddress, key: byIp() }));

  app.get(
    "/reports",
    { use: [charge(1)] },
    (c) => c.json({ reports: [], for: c.principal.subject }),
  );

  app.post("/exports", {
    use: [charge(3)],
    limits: { body: 1024 },
    body: v.object({ report: v.string().min(1).max(64) }),
  }, (c) => c.json({ exporting: c.body.report }, 202));

  return app;
}

let app: ReturnType<typeof build> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    app ??= build(env);
    return app.fetch(request, env, ctx);
  },
};
