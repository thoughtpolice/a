// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A Worker that exercises `@celld/api/jev` on the real celld runtime: the client
 * over real `fetch`, a `durableLimiter` over the `RateLimitShard` Durable
 * Objects, and the KV cache. `tests/runtime_test.py` drives it against a fake
 * TypeSafe server whose address each request names in `?base=`, since the
 * port is only known once the test has bound it; `?limiter=` names the
 * limiter key and `?limits=` its limits, as JSON. This is a test fixture, not
 * an example of taking a base URL or limits from a request.
 *
 * @module
 */

import {
  choice,
  JevClient,
  type JevEnv,
  jevPolicies,
  noul,
  score,
} from "@celld/api/jev";
import { kvCache } from "@celld/api/jev/cache";
import {
  durableLimiter,
  type RateLimiter,
  type RateLimitShardApi,
} from "@celld/sec/ratelimit";

export { RateLimitShard } from "@celld/sec/ratelimit/durable";

interface Env extends JevEnv {
  RATE_LIMITS: DurableObjectNamespace<RateLimitShardApi>;
  JEV_CACHE: KVNamespace;
}

function limiter(url: URL, env: Env): RateLimiter {
  return durableLimiter(env.RATE_LIMITS, {
    name: "jev",
    policies: jevPolicies(JSON.parse(url.searchParams.get("limits") ?? "{}")),
  });
}

const questions = {
  urgent: noul("Does this convey urgency?", { true: "Time-sensitive" }),
  team: choice("Which team should handle this?", {
    billing: "Payments, invoicing, refunds",
    technical: "Bugs, outages, integrations",
    sales: null,
  }),
  mood: score("How frustrated is the customer?", [
    "Calm",
    "Frustrated",
    "Very angry",
  ]),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function ask(url: URL, request: Request, env: Env): Promise<Response> {
  const base = url.searchParams.get("base");
  if (base === null) return json({ error: "missing ?base=" }, 400);
  const client = JevClient.fromEnv(env, {
    baseUrl: base,
    // The fake server is on loopback, and the test exercises retries of asks.
    allowLoopbackForDevelopment: true,
    idempotentAsks: url.searchParams.get("idempotent") !== "0",
    limiter: limiter(url, env),
    limiterKey: url.searchParams.get("limiter") ?? "default",
    cache: kvCache(env.JEV_CACHE, { ttlSeconds: 3600 }),
    retry: { backoffInitialMs: 50, backoffMaxMs: 200 },
    timeoutMs: Number(url.searchParams.get("timeout") ?? 5000),
  });
  const { state, model } = await request.json() as {
    state: string;
    model?: string;
  };
  const outcome = await client.tryAsk({ state, questions, model });
  if (!outcome.ok) return json(outcome);
  // Reading the typed answers here is the compile-time half of the test.
  const { answers } = outcome.result;
  const summary: {
    team: "billing" | "technical" | "sales";
    urgent: number;
    mood: "Calm" | "Frustrated" | "Very angry";
  } = {
    team: answers.team.choice,
    urgent: answers.urgent.noul,
    mood: answers.mood.legend["1"],
  };
  return json({ ...outcome, summary });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ask" && request.method === "POST") {
      return await ask(url, request, env);
    }
    if (url.pathname === "/limits" && request.method === "GET") {
      const key = url.searchParams.get("limiter") ?? "default";
      return json(await limiter(url, env).peek(key, { cost: 0 }));
    }
    return json({ error: "not found" }, 404);
  },
};
