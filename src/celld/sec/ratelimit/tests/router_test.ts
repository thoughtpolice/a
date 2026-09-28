// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import { apiKey, hashApiKey, hashedKeys, router } from "@celld/web/router";
import {
  durableLimiter,
  memoryLimiter,
  type RateLimiter,
} from "@celld/sec/ratelimit";
import { byIp, byPrincipal, rateLimit } from "@celld/sec/ratelimit/router";
import { ManualClock, memoryNamespace } from "@celld/sec/ratelimit/testing";

const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  abort: () => {},
  exports: {},
  props: undefined,
};

interface Fetches {
  fetch(
    request: Request,
    env: unknown,
    ctx: ExecutionContext,
  ): Promise<Response>;
}

async function send(
  app: Fetches,
  path: string,
  headers: Record<string, string> = {},
) {
  const response = await app.fetch(
    new Request(`https://api.example.com${path}`, { headers }),
    {},
    ctx,
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    json: text === "" ? undefined : JSON.parse(text),
  };
}

function limiter(clock: ManualClock, limit: number, name = "address") {
  return memoryLimiter({
    name: `test-${name}`,
    policies: [{ name, limit, window: "PT1M" }],
    now: clock.now,
  });
}

Deno.test("router: a held key's 429 says nothing is left until the hold ends", async () => {
  const clock = new ManualClock();
  const held = limiter(clock, 10, "api");
  await held.hold("ip:192.0.2.1/32", { forMs: 30_000 });
  const app = router({ auth: "none" })
    .use(rateLimit({ limiter: held, key: byIp() }));
  app.get("/", { public: true }, (c) => c.json({ ok: true }));
  const refused = await send(app, "/", { "cf-connecting-ip": "192.0.2.1" });
  assertEquals(refused.status, 429);
  assertEquals(refused.headers.get("retry-after"), "30");
  assertEquals(refused.headers.get("ratelimit"), '"api";r=0;t=30');
});

Deno.test("router: per address, with RateLimit fields and a 429", async () => {
  const clock = new ManualClock();
  const app = router({ auth: "none" })
    .use(rateLimit({ limiter: limiter(clock, 2), key: byIp() }));
  app.get("/", { public: true }, (c) => c.json({ ok: true }));
  const client = { "cf-connecting-ip": "192.0.2.10" };

  const first = await send(app, "/", client);
  assertEquals(first.status, 200);
  assertEquals(first.headers.get("ratelimit-policy"), '"address";q=2;w=60');
  assertEquals(first.headers.get("ratelimit"), '"address";r=1;t=30');
  assertEquals((await send(app, "/", client)).status, 200);

  const refused = await send(app, "/", client);
  assertEquals(refused.status, 429);
  assertEquals(refused.json.error, "rate_limited");
  assertEquals(refused.headers.get("retry-after"), "30");
  assertEquals(refused.headers.get("ratelimit"), '"address";r=0;t=60');
  // The router's own headers are still there.
  assertEquals(refused.headers.get("x-content-type-options"), "nosniff");
  assert(refused.headers.get("x-request-id") !== null, "a request id");

  // Another address has its own budget; 404s are limited too.
  assertEquals(
    (await send(app, "/", { "cf-connecting-ip": "192.0.2.11" })).status,
    200,
  );
  assertEquals((await send(app, "/missing", client)).status, 429);
  clock.advance(30_000);
  assertEquals((await send(app, "/", client)).status, 200);
});

Deno.test("router: one IPv6 /64 is one client, and no address is one key", async () => {
  const clock = new ManualClock();
  const app = router({ auth: "none" })
    .use(rateLimit({ limiter: limiter(clock, 1), key: byIp() }));
  app.get("/", { public: true }, (c) => c.json({ ok: true }));
  assertEquals(
    (await send(app, "/", { "cf-connecting-ip": "2001:db8:1:2::1" })).status,
    200,
  );
  assertEquals(
    (await send(app, "/", { "cf-connecting-ip": "2001:db8:1:2::ffff" })).status,
    429,
  );
  assertEquals((await send(app, "/")).status, 200);
  assertEquals((await send(app, "/")).status, 429);
});

async function keyedApp(
  clock: ManualClock,
  perCaller: RateLimiter,
) {
  const keys = hashedKeys({
    [await hashApiKey("key-alice")]: { subject: "alice" },
    [await hashApiKey("key-bob")]: { subject: "bob" },
  });
  const app = router({ auth: apiKey({ lookup: keys }) })
    .use(rateLimit({ limiter: limiter(clock, 10), key: byIp() }));
  app.get(
    "/reports",
    {
      use: [rateLimit({ limiter: perCaller, key: byPrincipal(), cost: 2 })],
    },
    (c) => c.json({ for: c.principal.subject }),
  );
  app.get("/status", { public: true }, (c) => c.json({ ok: true }));
  return app;
}

Deno.test("router: per caller after authentication, with both limits in the fields", async () => {
  const clock = new ManualClock();
  const app = await keyedApp(clock, limiter(clock, 4, "caller"));
  const alice = { "x-api-key": "key-alice", "cf-connecting-ip": "192.0.2.1" };
  const first = await send(app, "/reports", alice);
  assertEquals(first.status, 200);
  assertEquals(
    first.headers.get("ratelimit-policy"),
    '"address";q=10;w=60, "caller";q=4;w=60',
  );
  assertEquals(
    first.headers.get("ratelimit"),
    '"address";r=9;t=6, "caller";r=2;t=30',
  );
  assertEquals((await send(app, "/reports", alice)).status, 200);
  const refused = await send(app, "/reports", alice);
  assertEquals(refused.status, 429);
  assertEquals(refused.headers.get("retry-after"), "30");
  // Bob, from the same address, has his own quota.
  assertEquals(
    (await send(app, "/reports", { ...alice, "x-api-key": "key-bob" })).status,
    200,
  );
  // An unauthenticated request is refused before the per-caller limit, and
  // a public route is not charged to a caller.
  assertEquals(
    (await send(app, "/reports", { "cf-connecting-ip": "192.0.2.1" })).status,
    401,
  );
  const status = await send(app, "/status", {
    "cf-connecting-ip": "192.0.2.1",
  });
  assertEquals(status.headers.get("ratelimit-policy"), '"address";q=10;w=60');
});

Deno.test("router: an unreachable limiter refuses with 503, or lets through", async () => {
  const clock = new ManualClock();
  const namespace = memoryNamespace({ now: clock.now });
  const shared = durableLimiter(namespace, {
    name: "api",
    policies: [{ name: "api", limit: 5, window: "PT1M" }],
  });
  const seen: unknown[] = [];
  const strict = router({ auth: "none" }).use(rateLimit({
    limiter: shared,
    key: byIp(),
    onUnavailable: (error) => seen.push(error),
  }));
  strict.get("/", { public: true }, (c) => c.json({ ok: true }));
  const lenient = router({ auth: "none" }).use(rateLimit({
    limiter: () => shared,
    key: byIp(),
    unavailable: "allow",
  }));
  lenient.get("/", { public: true }, (c) => c.json({ ok: true }));

  namespace.failWith = new Error("owner_unreachable");
  const refused = await send(strict, "/");
  assertEquals(refused.status, 503);
  assertEquals(refused.headers.get("retry-after"), "1");
  assertEquals(seen.length, 1);
  const allowed = await send(lenient, "/");
  assertEquals(allowed.status, 200);
  assertEquals(allowed.headers.get("ratelimit"), null);
});

Deno.test("router: a null key, no fields, and a cost function", async () => {
  const clock = new ManualClock();
  const perPath = limiter(clock, 3, "path");
  const app = router({ auth: "none" }).use(rateLimit({
    limiter: perPath,
    key: (c) => c.url.pathname === "/free" ? null : "shared",
    cost: (c) => c.url.pathname === "/expensive" ? 3 : 1,
    headers: false,
  }));
  app.get("/free", { public: true }, (c) => c.json({}));
  app.get("/cheap", { public: true }, (c) => c.json({}));
  app.get("/expensive", { public: true }, (c) => c.json({}));
  const cheap = await send(app, "/cheap");
  assertEquals([cheap.status, cheap.headers.get("ratelimit")], [200, null]);
  const expensive = await send(app, "/expensive");
  assertEquals(expensive.status, 429);
  assertEquals(expensive.headers.get("ratelimit"), null);
  assertEquals(expensive.headers.get("retry-after"), "20");
  assertEquals((await send(app, "/free")).status, 200);
});

Deno.test("router: a cost above the burst is the application's error, a 500", async () => {
  const clock = new ManualClock();
  const app = router({ auth: "none" }).use(rateLimit({
    limiter: limiter(clock, 2),
    key: () => "k",
    cost: 5,
  }));
  app.get("/", { public: true }, (c) => c.json({}));
  assertEquals((await send(app, "/")).status, 500);
});

Deno.test("router: options are checked when the middleware is made", () => {
  const clock = new ManualClock();
  const good = { limiter: limiter(clock, 1), key: () => "k" };
  assertThrows(() => rateLimit({ ...good, key: "k" } as never), TypeError);
  assertThrows(() => rateLimit({ ...good, limiter: {} } as never), TypeError);
  assertThrows(
    () => rateLimit({ ...good, unavailable: "open" } as never),
    TypeError,
  );
  assertThrows(() => rateLimit({ ...good, per: "ip" } as never), TypeError);
  assertThrows(() => byIp({ ipv4Prefix: 40 }), RangeError);
});
