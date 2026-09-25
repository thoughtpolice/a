// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Wave-4 sweep (WP-13): fail-open defaults, live configuration and the
// shared transport rule, each a regression for a DB-SWP finding.

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import { generateKeyPair, sign } from "@celld/sec/jwt";
import {
  apiKey,
  type AuthScheme,
  cleartextRefusal,
  cors,
  dpop,
  hashApiKey,
  hashedKeys,
  isLoopbackLiteral,
  jwtBearer,
  jwtVerifier,
  type JwtVerifierOptions,
  type ReplayStore,
  router,
  RouterError,
  session,
  unsafeMemoryReplayStore,
} from "@celld/web/router";
import {
  assertStatus,
  call,
  dpopProof,
  proofKey,
  recordingContext,
} from "./fixture.ts";

// deno-lint-ignore no-explicit-any
const loose = (value: unknown): any => value;

Deno.test("DB-SWP-F4-13.R1: a scheme must say whether its credential is ambient", async () => {
  const cookieScheme = {
    name: "cookie",
    authenticate: (c: { cookie(name: string): string | undefined }) =>
      c.cookie("sid") === "s1" ? { subject: "ada" } : null,
  };
  // Leaving `ambient` out used to mean "not ambient", which silently
  // turned the CSRF check off for a cookie scheme.
  assertThrows(
    () => router({ auth: cookieScheme as unknown as AuthScheme }),
    RouterError,
    "ambient",
  );
  const app = router({
    auth: { ...cookieScheme, ambient: true } as AuthScheme,
  });
  app.post("/things", (c) => c.text("made"));
  assertStatus(
    await call(app, "/things", {
      method: "POST",
      headers: { cookie: "sid=s1", origin: "https://evil.example" },
    }),
    403,
  );
});

Deno.test("DB-SWP-F4-13.R2: jwtVerifier needs an issuer and an audience at run time", () => {
  const base = { keys: new Uint8Array(32), algorithms: ["HS256"] } as const;
  for (
    const bad of [
      { ...base, audience: "https://api.example.com" },
      { ...base, issuer: "https://as.example.com" },
      { ...base, issuer: [], audience: "https://api.example.com" },
      { ...base, issuer: "https://as.example.com", audience: [""] },
      { ...base, issuer: "", audience: "https://api.example.com" },
      { ...base, issuer: 7, audience: "https://api.example.com" },
    ]
  ) {
    assertThrows(
      () => jwtVerifier(bad as unknown as JwtVerifierOptions),
      RouterError,
      "jwtVerifier",
    );
  }
  assertThrows(
    () =>
      jwtVerifier({
        keys: new Uint8Array(32),
        issuer: "https://as.example.com",
        audience: "https://api.example.com",
      } as unknown as JwtVerifierOptions),
    RouterError,
    "algorithm",
  );
});

Deno.test("DB-SWP-F5-13.R1: a session principal carries its expiry", async () => {
  const now = { t: 1_000_000 };
  const sessions = session({
    keys: [{ id: "k1", secret: "0123456789abcdef0123456789abcdef" }],
    now: () => now.t,
    maxAge: "PT1H",
  });
  const app = router({ auth: sessions });
  app.post("/login", { public: true, csrf: false }, async (c) => {
    await sessions.issue(c, { subject: "ada" });
    return c.text("in");
  });
  app.get("/me", (c) => c.json({ expiresAt: c.principal.expiresAt ?? null }));
  const login = await call(app, "/login", { method: "POST" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  now.t += 1000;
  assertEquals((await call(app, "/me", { headers: { cookie } })).json, {
    expiresAt: 1_000_000 + 3_600_000,
  });
});

Deno.test("DB-SWP-F15-13.R1: dpop captures its replay store and nonce methods", async () => {
  const NOW = Date.UTC(2026, 8, 25, 12);
  const now = () => NOW;
  const key = await proofKey();
  const verify = () => ({ subject: "ada", cnf: { jkt: key.jkt } });
  const inner = unsafeMemoryReplayStore({ now });
  const store = { claim: (k: string, e: number) => inner.claim(k, e) };
  const app = router({
    auth: dpop({ verify, replay: store as ReplayStore, now }),
  });
  app.get("/things", (c) => c.text(c.principal.subject));
  store.claim = () => Promise.resolve(true);
  const proof = await dpopProof(key, { token: "t", now: NOW });
  const send = () =>
    call(app, "/things", {
      origin: "https://api.example.com",
      headers: { authorization: "DPoP t", dpop: proof },
    });
  assertStatus(await send(), 200);
  assertStatus(await send(), 401);

  let current = "n1";
  const nonce = {
    issue: () => Promise.resolve(current),
    check: (n: string) => Promise.resolve(n === current),
  };
  const nonced = router({
    auth: dpop({
      verify,
      replay: unsafeMemoryReplayStore({ now }),
      nonce,
      now,
    }),
  });
  nonced.get("/things", (c) => c.text(c.principal.subject));
  nonce.check = () => Promise.resolve(true);
  current = "n2";
  const stale = await dpopProof(key, { token: "t", now: NOW, nonce: "n1" });
  const answer = await call(nonced, "/things", {
    origin: "https://api.example.com",
    headers: { authorization: "DPoP t", dpop: stale },
  });
  assertStatus(answer, 401);
  assert(
    (answer.headers.get("www-authenticate") ?? "").includes("use_dpop_nonce"),
    "a stale nonce is still refused",
  );
});

Deno.test("DB-SWP-F16-13.R1: custom schemes apply the shared cleartext rule", async () => {
  const token: AuthScheme = {
    name: "platform",
    ambient: false,
    authenticate(c) {
      const sent = c.req.headers.get("x-platform-token");
      if (sent === null) return null;
      return cleartextRefusal(c, "platform tokens") ??
        (sent === "t1" ? { subject: "ada" } : null);
    },
  };
  const app = router({ auth: token });
  app.get("/me", (c) => c.text(c.principal.subject));
  const headers = { "x-platform-token": "t1" };
  const refused = await call(app, "/me", {
    origin: "http://api.example.com",
    headers,
  });
  assertStatus(refused, 403);
  assertEquals(refused.headers.get("www-authenticate"), null);
  assertStatus(
    await call(app, "/me", { origin: "http://127.0.0.1:8080", headers }),
    200,
  );
  assert(
    isLoopbackLiteral("[::1]") && !isLoopbackLiteral("localhost"),
    "the shared loopback rule is literal-only",
  );
});

Deno.test("DB-SWP-F15-13.R2: jwtVerifier copies plain key sets", async () => {
  const a = await generateKeyPair("ES256", { kid: "a" });
  const b = await generateKeyPair("ES256", { kid: "b" });
  const jwks = { keys: [a.publicJwk] };
  const app = router({
    auth: jwtBearer({
      keys: jwks,
      issuer: "https://as.example.com",
      audience: "https://api.example.com",
      algorithms: ["ES256"],
    }),
  });
  app.get("/me", (c) => c.text(c.principal.subject));
  jwks.keys.push(b.publicJwk);
  const mint = (key: CryptoKey, kid: string) =>
    sign(
      {
        iss: "https://as.example.com",
        aud: "https://api.example.com",
        sub: "ada",
      },
      key,
      { alg: "ES256", kid, typ: "at+jwt", expiresIn: 300 },
    );
  const as = async (key: CryptoKey, kid: string) =>
    await call(app, "/me", {
      headers: { authorization: `Bearer ${await mint(key, kid)}` },
    });
  assertStatus(await as(a.privateKey, "a"), 200);
  assertStatus(await as(b.privateKey, "b"), 401);
});

Deno.test("DB-SWP-F15-13.R3: hashedKeys copies its table's principals", async () => {
  const hash = await hashApiKey("k-1");
  const table = { [hash]: { subject: "ada", scopes: ["read"] } };
  const app = router({ auth: apiKey({ lookup: hashedKeys(table) }) });
  app.get("/admin", { scopes: ["admin"] }, (c) => c.text("admin"));
  loose(table[hash].scopes).push("admin");
  loose(table[hash]).subject = "root";
  assertStatus(
    await call(app, "/admin", { headers: { "x-api-key": "k-1" } }),
    403,
  );
});

// Follow-up sweep (WP-13b): findings other sweepers filed to the router.

Deno.test("DB-SWP-F7-207: cors maxAge must be whole seconds within a day", async () => {
  for (const maxAge of [NaN, -1, 1.5, Infinity, 86_401]) {
    assertThrows(
      () => cors({ origins: ["https://app.example.com"], maxAge }),
      RouterError,
      "maxAge",
    );
  }
  const app = router({ auth: "none" });
  app.use(cors({ origins: ["https://app.example.com"], maxAge: 0 }));
  app.post("/x", (c) => c.text("ok"));
  const answer = await call(app, "/x", {
    method: "OPTIONS",
    headers: {
      origin: "https://app.example.com",
      "access-control-request-method": "POST",
    },
  });
  assertEquals(answer.headers.get("access-control-max-age"), "0");
});

Deno.test("DB-SWP-F10-111: a timed-out request says its outcome is unknown and keeps the work alive", async () => {
  const app = router({ auth: "none", limits: { timeout: 0.05 } });
  let finish!: () => void;
  let wrote = false;
  app.post("/slow", async (c) => {
    // A handler that ignores c.signal: its side effect still happens.
    await new Promise<void>((resolve) => finish = resolve);
    wrote = true;
    return c.text("late");
  });
  const ctx = recordingContext();
  const answer = await call(app, "/slow", { method: "POST", ctx });
  // Not 503, which tells clients and proxies the request was not
  // processed and invites a retry of a write that may still land.
  assertStatus(answer, 504);
  assertEquals(answer.json?.error, "timeout");
  assertEquals(answer.headers.get("retry-after"), null);
  assert(
    String(answer.json?.message).includes("may still"),
    String(answer.json?.message),
  );
  // The abandoned handler is held by waitUntil, so the runtime does not
  // tear it down half-way through its side effects.
  assertEquals(ctx.pending.length, 1);
  finish();
  await Promise.all(ctx.pending);
  assert(wrote, "the handler ran to completion");
});

// DB-REV-RTR-4: once the time budget has run out (the client has its
// 504), the pipeline stops at the next stage boundary: a slow
// authentication does not go on to `authorize`, validation or the
// handler's side effects.
Deno.test("after a 504 the route does not go on to authorize or the handler", async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let authorized = 0;
  let ran = 0;
  let used = 0;
  const slow = {
    name: "slow",
    ambient: false,
    authenticate: async () => {
      await sleep(80);
      return { subject: "ada" };
    },
  } satisfies AuthScheme;
  const app = router({ auth: slow, limits: { timeout: 0.02 } });
  app.post("/pay", {
    csrf: false,
    authorize: () => {
      authorized++;
      return true;
    },
    use: [async (_c, next) => {
      used++;
      return await next();
    }],
  }, (c) => {
    ran++;
    return c.text("paid");
  });
  const ctx = recordingContext();
  const answer = await call(app, "/pay", { method: "POST", ctx });
  assertStatus(answer, 504);
  await Promise.all(ctx.pending);
  await sleep(150);
  assertEquals([authorized, used, ran], [0, 0, 0]);

  // A slow `before` middleware: authentication is not even started.
  let authenticated = 0;
  const counted = {
    name: "counted",
    ambient: false,
    authenticate: () => {
      authenticated++;
      return { subject: "ada" };
    },
  } satisfies AuthScheme;
  const late = router({ auth: counted, limits: { timeout: 0.02 } });
  late.post("/pay", {
    csrf: false,
    before: [async (_c, next) => {
      await sleep(60);
      return await next();
    }],
  }, (c) => {
    ran++;
    return c.text("paid");
  });
  const lateCtx = recordingContext();
  assertStatus(await call(late, "/pay", { method: "POST", ctx: lateCtx }), 504);
  await Promise.all(lateCtx.pending);
  await sleep(100);
  assertEquals([authenticated, ran], [0, 0]);
});
