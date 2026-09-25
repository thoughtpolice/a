// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  type AnswerCache,
  choice,
  JevClient,
  noul,
  score,
} from "@celld/api/jev";
import { cacheKey, kvCache, memoryCache } from "@celld/api/jev/cache";
import {
  fakeBody,
  fakeFetch,
  jsonResponse,
  virtualRuntime,
} from "@celld/api/jev/testing";

const questions = {
  urgent: noul("Urgent?"),
  team: choice("Team?", { billing: "Payments", technical: null }),
  mood: score("Mood?", ["Calm", "Angry"]),
};
const pinned = { state: { ticket: "refund" }, questions, model: "jev-1.13.0" };

function setup(cache: AnswerCache, model = "jev-1.13.0") {
  const fetch = fakeFetch(({ body }) =>
    jsonResponse(fakeBody(body.questions, { model }))
  );
  const client = new JevClient({
    apiKey: "k",
    fetch,
    cache,
    runtime: virtualRuntime(),
  });
  return { fetch, client };
}

Deno.test("keys are SHA-256 over model, state and questions", async () => {
  const key = await cacheKey(pinned);
  assert(/^jev\/v1\/[0-9a-f]{64}$/.test(key), key);
  assertEquals(await cacheKey({ ...pinned }), key);
  const others = await Promise.all([
    cacheKey({ ...pinned, model: "jev-1.13.1" }),
    cacheKey({ ...pinned, state: { ticket: "refund!" } }),
    cacheKey({ ...pinned, questions: { urgent: noul("Urgent?") } }),
    // Option order is part of what the model reads.
    cacheKey({
      ...pinned,
      questions: {
        ...questions,
        team: choice("Team?", { technical: null, billing: "Payments" }),
      },
    }),
  ]);
  assertEquals(new Set([key, ...others]).size, 5);
});

Deno.test("a pinned request is answered from the cache the second time", async () => {
  const { fetch, client } = setup(memoryCache({ ttlMs: 60_000 }));
  const first = await client.ask(pinned);
  const second = await client.ask(pinned);
  assertEquals(fetch.calls.length, 1);
  assertEquals([first.meta.cache, first.meta.attempts], ["miss", 1]);
  assertEquals(
    [second.meta.cache, second.meta.attempts, second.meta.requestId],
    [
      "hit",
      0,
      null,
    ],
  );
  assertEquals(second.answers, first.answers);
  assertEquals(second.usage, first.usage);
  assertEquals(second.model, "jev-1.13.0");
});

Deno.test("aliases bypass the cache, since the model behind them moves", async () => {
  const { fetch, client } = setup(memoryCache({ ttlMs: 60_000 }));
  const request = { state: "s", questions, model: "jev-latest" };
  await client.ask(request);
  const again = await client.ask(request);
  assertEquals(fetch.calls.length, 2);
  assertEquals(again.meta.cache, "bypass");
});

Deno.test("an answer from another model is not stored", async () => {
  const { fetch, client } = setup(memoryCache({ ttlMs: 60_000 }), "jev-1.14.0");
  await client.ask(pinned);
  await client.ask(pinned);
  assertEquals(fetch.calls.length, 2);
});

Deno.test("corrupt entries and cache failures are misses", async () => {
  const store = new Map<string, string>();
  const corrupt: AnswerCache = {
    get: (key) => Promise.resolve(store.get(key) ?? null),
    put: (key) => {
      store.set(key, '{"model":"jev-1.13.0","answers":{}}');
      return Promise.resolve();
    },
  };
  const first = setup(corrupt);
  await first.client.ask(pinned);
  const second = await first.client.ask(pinned);
  assertEquals([first.fetch.calls.length, second.meta.cache], [2, "miss"]);

  const broken: AnswerCache = {
    get: () => Promise.reject(new Error("kv down")),
    put: () => Promise.reject(new Error("kv down")),
  };
  const failing = setup(broken);
  const result = await failing.client.ask(pinned);
  assertEquals([result.meta.cache, result.answers.urgent.noul], ["miss", 1]);
});

Deno.test("the memory cache expires and evicts", async () => {
  let now = 0;
  const cache = memoryCache({ ttlMs: 100, maxEntries: 2, now: () => now });
  await cache.put("a", "1");
  await cache.put("b", "2");
  await cache.put("c", "3");
  assertEquals(await cache.get("a"), null);
  assertEquals(await cache.get("b"), "2");
  now = 100;
  assertEquals(await cache.get("c"), null);
});

Deno.test("the KV cache writes with a TTL under its prefix", async () => {
  const writes: unknown[] = [];
  const kv = {
    get: (key: string) => Promise.resolve(key === "p/k" ? "v" : null),
    put: (key: string, value: string, options: unknown) => {
      writes.push([key, value, options]);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
  const cache = kvCache(kv, { ttlSeconds: 3600, prefix: "p/" });
  assertEquals(await cache.get("k"), "v");
  await cache.put("k", "w");
  assertEquals(writes, [["p/k", "w", { expirationTtl: 3600 }]]);
  let message = "";
  try {
    kvCache(kv, { ttlSeconds: 30 });
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message, "ttlSeconds must be an integer of at least 60, got 30");
});
