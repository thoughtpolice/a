// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects, assertThrows } from "@celld/core/assert";
import {
  apiKey,
  AuthError,
  basic,
  bearer,
  CookieKeyring,
  cors,
  dpop,
  hashedKeys,
  HttpError,
  jwtVerifier,
  principalFromClaims,
  router,
  RouterError,
  serializeCookie,
  session,
  toPrincipal,
  unsafeMemoryReplayStore,
} from "@celld/web/router";
import { openapi } from "@celld/web/router/openapi";
import { call, dpopProof, proofKey } from "./fixture.ts";

Deno.test("Daybreak route option typos and empty restrictions are rejected", () => {
  for (
    const options of [{ scope: ["admin"] }, { scopes: [] }, { roles: [] }, {
      limits: { timeot: 1 },
    }, { responses: { 200: { description: "ok", schem: {} } } }]
  ) {
    const app = router({
      auth: apiKey({ lookup: () => ({ subject: "user" }) }),
    });
    assertThrows(
      () => app.get("/", options as never, (c) => c.text("secret")),
      RouterError,
    );
  }
});

Deno.test("Daybreak cookie defaults validate before serving and key arrays never execute accessors", () => {
  for (
    const cookies of [
      { path: "relative" },
      { domain: "bad;domain" },
      { sameSite: "None", secure: false },
      { partitioned: true, secure: false },
    ]
  ) {
    assertThrows(
      () => router({ auth: "none", cookies: cookies as never }),
      RouterError,
    );
  }
  let called = false;
  const keys = [{ id: "current", secret: "01234567890123456789012345678901" }];
  Object.defineProperty(keys, "0", {
    get() {
      called = true;
      return {};
    },
    enumerable: true,
  });
  assertThrows(() => new CookieKeyring(keys), RouterError);
  assertEquals(called, false);
});

Deno.test("Daybreak API key responses and refusals never inherit shared freshness", async () => {
  const app = router({ auth: apiKey({ lookup: () => ({ subject: "user" }) }) });
  app.get(
    "/",
    (c) => c.text("secret", { headers: { "cache-control": "max-age=60" } }),
  );
  for (const key of ["valid", "bad key"]) {
    const answer = await call(app, "/", { headers: { "x-api-key": key } });
    assertEquals(answer.headers.get("cache-control"), "private, no-store");
  }
});

Deno.test("Daybreak nested CORS checks inner method before any handler or middleware", async () => {
  let ran = 0;
  const app = router({ auth: "none" }).use(
    cors({ origins: "*", methods: ["GET", "POST"] }),
  );
  const child = router({ auth: "none" }).use(
    cors({ origins: "*", methods: ["GET"] }),
  );
  child.use(async (_c, next) => {
    ran++;
    return await next();
  });
  child.post("/", () => {
    ran++;
    return new Response("mutation");
  });
  app.mount("/child", child);
  const answer = await call(app, "/child", {
    method: "OPTIONS",
    headers: {
      origin: "https://app.example.com",
      "access-control-request-method": "POST",
    },
  });
  assertEquals(answer.status, 403);
  assertEquals(ran, 0);
});

Deno.test("Daybreak authorization callbacks never grant by truthiness", async () => {
  for (const value of ["true", "false", 1, 0, {}, null, undefined]) {
    const app = router({
      auth: apiKey({ lookup: () => ({ subject: "user" }) }),
    });
    app.get(
      "/",
      { authorize: (() => value) as never },
      (c) => c.text("secret"),
    );
    assertEquals(
      (await call(app, "/", { headers: { "x-api-key": "valid" } })).status,
      500,
    );
  }
});

Deno.test("Daybreak error values are checked before they can expose secrets", () => {
  for (const status of [200, 302, 500, 999, NaN, 401.5]) {
    assertThrows(
      () => new AuthError("invalid_token", "secret", { status }),
      RangeError,
    );
  }
  assertThrows(() =>
    new HttpError(500, "secret", { expose: "false" as never })
  );
});

Deno.test("Daybreak trusted malformed proxy fields fail closed", async () => {
  const app = router({
    auth: "none",
    clientIp: { peer: () => "10.0.0.2" },
    publicUrl: { mode: "trusted-proxy", trustedProxies: ["10.0.0.0/8"] },
  });
  app.get("/", (c) => c.text(c.publicUrl.href));
  for (const host of ["bad/path", "u@host", "a,b", "a:99999"]) {
    assertEquals(
      (await call(app, "/", {
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": host },
      })).status,
      400,
    );
  }
});

Deno.test("Daybreak nested claims are immutable and malformed confirmation cannot downgrade", () => {
  const claims = { nested: { role: "reader" } };
  const principal = toPrincipal({ subject: "user", claims }, "test");
  claims.nested.role = "admin";
  assertEquals((principal.claims.nested as { role: string }).role, "reader");
  assertThrows(
    () => ((principal.claims.nested as { role: string }).role = "admin"),
  );
  for (const cnf of [null, [], {}, { jkt: 1 }, { jkt: "" }]) {
    assertEquals(principalFromClaims({ sub: "user", cnf }), null);
  }
});

Deno.test("Daybreak a zero global timeout starts no middleware", async () => {
  let ran = 0;
  const app = router({ auth: "none", limits: { timeout: 0 } }).use(
    async (_c, next) => {
      ran++;
      return await next();
    },
  );
  app.get("/", (c) => c.text("ok"));
  assertEquals((await call(app, "/")).status, 504);
  assertEquals(ran, 0);
});

Deno.test("Daybreak every security factory rejects unknown keys and wrong types", () => {
  const secret = "s".repeat(32);
  const cases: [
    ((extra: Record<string, unknown>) => unknown),
    Record<string, unknown>,
  ][] = [
    [(extra) => router({ auth: "none", ...extra }), {
      allowCleartextCredentialsForDevelopment: "false",
    }],
    [(extra) => router({ auth: "none", limits: { ...extra } }), { body: "2" }],
    [(extra) => router({ auth: "none", security: { ...extra } }), {
      noStore: "false",
    }],
    [(extra) => router({ auth: "none", clientIp: { ...extra } }), {
      strict: "false",
    }],
    [
      (extra) =>
        router({ auth: "none", publicUrl: { mode: "request", ...extra } }),
      { mode: 1 },
    ],
    [(extra) => cors({ origins: "*", ...extra }), { credentials: "false" }],
    [(extra) => basic({ verify: () => null, ...extra }), { verify: true }],
    [(extra) => apiKey({ lookup: () => null, ...extra }), {
      header: "bad header",
    }],
    [(extra) => bearer({ verify: () => null, ...extra }), {
      allowQuery: "false",
    }],
    [
      (extra) =>
        jwtVerifier({
          keys: new TextEncoder().encode(secret),
          issuer: "issuer",
          audience: "audience",
          algorithms: ["HS256"],
          ...extra,
        }),
      { principal: true },
    ],
    [
      (extra) =>
        dpop({
          verify: () => null,
          replay: unsafeMemoryReplayStore(),
          ...extra,
        }),
      { now: 1 },
    ],
    [(extra) => session({ keys: [{ id: "a", secret }], ...extra }), {
      encrypt: "false",
    }],
    [(extra) => unsafeMemoryReplayStore(extra), { now: true }],
    [(extra) => serializeCookie("x", "v", extra), { secure: "false" }],
    [
      (extra) =>
        openapi(router({ auth: "none" }), {
          info: { title: "api", version: "1" },
          ...extra,
        }),
      { exclude: true },
    ],
  ];
  for (const [make, wrong] of cases) {
    assertThrows(() => make({ typo: true }), RouterError);
    assertThrows(() => make(wrong), RouterError);
  }
  let invoked = false;
  assertThrows(() =>
    router({
      get auth() {
        invoked = true;
        return "none" as const;
      },
    }), RouterError);
  assertEquals(invoked, false);
  assertThrows(
    () =>
      hashedKeys({
        ["a".repeat(64)]: { subject: "a" },
        ["A".repeat(64)]: { subject: "b" },
      }),
    RouterError,
  );
});

Deno.test("Daybreak nested CORS intersects headers, exposure, credentials and max-age", async () => {
  const app = router({ auth: "none" }).use(
    cors({
      origins: ["https://app.example.com"],
      credentials: true,
      methods: ["GET", "POST"],
      allowHeaders: ["x-one", "x-two"],
      exposeHeaders: ["x-one", "x-two"],
      maxAge: 100,
    }),
  );
  const child = router({ auth: "none" }).use(
    cors({
      origins: "*",
      methods: ["GET"],
      allowHeaders: ["x-one"],
      exposeHeaders: ["x-one"],
      maxAge: 10,
    }),
  );
  child.get("/", (c) => c.text("ok"));
  app.mount("/nested", child);
  const request = (header: string) =>
    call(app, "/nested", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example.com",
        "access-control-request-method": "GET",
        "access-control-request-headers": header,
      },
    });
  const good = await request("x-one");
  assertEquals(good.status, 204);
  for (
    const [name, expected] of [
      ["access-control-allow-methods", "GET"],
      ["access-control-allow-headers", "x-one"],
      ["access-control-max-age", "10"],
      ["access-control-allow-origin", "https://app.example.com"],
      ["access-control-allow-credentials", null],
    ]
  ) assertEquals(good.headers.get(name!), expected);
  assertEquals((await request("x-two")).status, 403);
  const actual = await call(app, "/nested", {
    headers: { origin: "https://app.example.com" },
  });
  assertEquals(actual.headers.get("access-control-expose-headers"), "x-one");
});

Deno.test("Daybreak CORS and DPoP callbacks require exact booleans", async () => {
  const key = await proofKey();
  for (const value of ["true", "false", 1, 0, {}, null, undefined]) {
    const app = router({ auth: "none" }).use(
      cors({ origins: (() => value) as never }),
    );
    app.get("/", (c) => c.text("ok"));
    const answer = await call(app, "/", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example.com",
        "access-control-request-method": "GET",
      },
    });
    assertEquals(answer.status, 500);
    assertEquals(answer.headers.get("access-control-allow-origin"), null);
    const proof = await dpopProof(key, {
      token: "bound",
      url: "https://api.example.com/",
    });
    const protectedApp = router({
      auth: dpop({
        verify: () => ({ subject: "u", cnf: { jkt: key.jkt } }),
        replay: { claim: (() => Promise.resolve(value)) as never },
      }),
    });
    protectedApp.get("/", (c) => c.text("secret"));
    assertEquals(
      (await call(protectedApp, "/", {
        headers: { authorization: "DPoP bound", dpop: proof },
      })).status,
      500,
    );
  }
});

Deno.test("Daybreak cookies and sessions reject oversized, mutable, or invalid security facts", async () => {
  for (
    const keys of [null, [], [{ id: "a", secret: [] }], [{
      id: "a",
      secret: "x".repeat(31),
    }], [{ id: "a", secret: "x".repeat(32), typo: true }]]
  ) assertThrows(() => new CookieKeyring(keys as never), RouterError);
  const keys = new CookieKeyring([{ id: "a", secret: "x".repeat(32) }]);
  assertEquals(await keys.unseal("s", "a".repeat(3801)), null);
  await assertRejects(() => keys.seal("s", "é".repeat(1351)), RouterError);
  assertThrows(
    () => session({ keys, cookieOptions: { secure: false } }),
    RouterError,
  );
  const scheme = session({ keys });
  const app = router({ auth: "none" });
  app.get("/", async (c) => {
    await scheme.issue(c, { subject: "u", claims: [] as never });
    return c.text("ok");
  });
  const answer = await call(app, "/");
  assertEquals(answer.status, 500);
  assertEquals(answer.headers.get("set-cookie"), null);
});

Deno.test("Daybreak errors snapshot headers, scopes and nested details", () => {
  const headers = new Headers({ "x-test": "original" });
  const scope = ["read"];
  const error = new AuthError("insufficient_scope", "scope", {
    headers,
    scope,
  });
  headers.set("x-test", "changed");
  scope.push("admin");
  error.headers.set("x-test", "changed");
  assertEquals(error.headers.get("x-test"), "original");
  assertEquals(error.scope, ["read"]);
  const details = { nested: { safe: true } };
  const http = new HttpError(400, "bad", { details, headers });
  details.nested.safe = false;
  assertEquals(http.details, { nested: { safe: true } });
});

Deno.test("Daybreak readiness checks custom auth before traffic and TRACE/CONNECT are refused", async () => {
  let checked = 0;
  const app = router({
    auth: {
      name: "custom",
      ambient: false,
      authenticate: () => null,
      ready: () => {
        checked++;
        return Promise.reject(new Error("unavailable"));
      },
    },
  });
  app.get("/", (c) => c.text("ok"));
  await assertRejects(() => app.ready(), Error, "unavailable");
  assertEquals(checked, 1);
  for (const method of ["TRACE", "CONNECT", "get", "bad method"]) {
    assertThrows(() => app.on(method, "/", (c) => c.text("ok")), RouterError);
  }
});
