// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A Worker that exercises `@celld/api/jev` on the real celld runtime: the client
 * over real `fetch`, the `JevRateLimiter` Durable Object and the KV cache.
 * `tests/runtime_test.py` drives it against a fake TypeSafe server whose
 * address each request names in `?base=`, since the port is only known once
 * the test has bound it. This is a test fixture, not an example of taking a
 * base URL from a request.
 *
 * @module
 */

import { choice, JevClient, type JevEnv, noul, score } from "@celld/api/jev";
import { kvCache } from "@celld/api/jev/cache";
import { durableLimiter, type RateLimiterApi } from "@celld/api/jev/limiter";

export { JevRateLimiter } from "@celld/api/jev/durable";

interface Env extends JevEnv {
  JEV_LIMITER: DurableObjectNamespace<RateLimiterApi>;
  JEV_CACHE: KVNamespace;
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
  const limiterName = url.searchParams.get("limiter") ?? "default";
  const client = JevClient.fromEnv(env, {
    baseUrl: base,
    limiter: durableLimiter(env.JEV_LIMITER, limiterName),
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
    const limiter = env.JEV_LIMITER.getByName(
      url.searchParams.get("limiter") ?? "default",
    );
    if (url.pathname === "/ask" && request.method === "POST") {
      return await ask(url, request, env);
    }
    if (url.pathname === "/limits" && request.method === "GET") {
      return json(await limiter.snapshot());
    }
    if (url.pathname === "/limits" && request.method === "POST") {
      return json(await limiter.configure(await request.json()));
    }
    return json({ error: "not found" }, 404);
  },
};
