// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DB-RTR-002: what a router was given is copied when it is given. Changing
// the caller's objects afterwards changes nothing the router does, and the
// router never freezes what it was handed.

import { assert, assertEquals } from "@celld/core/assert";
import { v } from "@celld/sieve";
import {
  apiKey,
  type AuthScheme,
  basic,
  bearer,
  type BearerOptions,
  cors,
  type CorsOptions,
  type Middleware,
  type PrincipalInput,
  type RouteOptions,
  router,
  type RouterOptions,
  session,
} from "@celld/web/router";
import { assertHeader, assertStatus, call } from "./fixture.ts";

const TOKENS: Record<string, PrincipalInput> = {
  reader: { subject: "ada", scopes: ["read"], roles: ["viewer"] },
  admin: { subject: "cy", scopes: ["read", "admin"], roles: ["admin"] },
};

const tokens = () => bearer({ verify: ({ token }) => TOKENS[token] ?? null });

const as = (token: string) => ({ authorization: `Bearer ${token}` });

/** Mutates a value the types call read-only, as a careless caller might. */
// deno-lint-ignore no-explicit-any
const loose = (value: unknown): any => value;

Deno.test("route scopes, roles, public and authorize are copied at registration", async () => {
  const scopes = ["admin"];
  const roles = ["admin"];
  const guarded: RouteOptions = { scopes, roles };
  const privateOptions: RouteOptions = {};
  const check: RouteOptions = { authorize: (p) => p.subject === "cy" };
  const app = router({ auth: tokens() });
  app.get("/admin", guarded, (c) => c.text("admin"));
  app.get("/private", privateOptions, (c) => c.text("private"));
  app.get("/cy", check, (c) => c.text("cy"));

  scopes.length = 0;
  roles.push("viewer");
  loose(guarded).public = true;
  loose(privateOptions).public = true;
  loose(check).authorize = () => true;

  assertStatus(await call(app, "/admin", { headers: as("reader") }), 403);
  assertStatus(await call(app, "/admin"), 401);
  assertStatus(await call(app, "/private"), 401);
  assertStatus(await call(app, "/cy", { headers: as("reader") }), 403);
  assertStatus(await call(app, "/cy", { headers: as("admin") }), 200);
  // The caller's objects are theirs: nothing was frozen in place.
  for (const value of [scopes, roles, guarded, privateOptions, check]) {
    assert(!Object.isFrozen(value), "caller objects are not frozen");
  }
});

Deno.test("route schemas, middleware, limits and csrf are copied at registration", async () => {
  const log: string[] = [];
  const tag = (name: string): Middleware => async (_c, next) => {
    log.push(name);
    return await next();
  };
  const use = [tag("use")];
  const before = [tag("before")];
  const limits = { body: 16 };
  const options: RouteOptions = {
    body: v.object({ n: v.number() }),
    query: v.object({ q: v.string() }),
    use,
    before,
    limits,
  };
  const app = router({ auth: "none" });
  app.post("/n", options, (c) => c.json(c.body));

  use.push(tag("late-use"));
  before.unshift(tag("late-before"));
  limits.body = 1_000_000;
  loose(options).body = v.unknown();
  loose(options).query = undefined;

  const big = await call(app, "/n?q=x", {
    json: { n: 1, pad: "x".repeat(64) },
  });
  assertStatus(big, 413);
  const bad = await call(app, "/n?q=x", { json: { n: "one" } });
  assertStatus(bad, 400);
  const noQuery = await call(app, "/n", { json: { n: 1 } });
  assertStatus(noQuery, 400);
  log.length = 0;
  assertEquals((await call(app, "/n?q=x", { json: { n: 1 } })).json, { n: 1 });
  assertEquals(log, ["before", "use"]);
});

Deno.test("scheme lists and schemes are copied when the router is made", async () => {
  const permissive: AuthScheme = {
    name: "anyone",
    ambient: false,
    authenticate: () => ({ subject: "mallory", scopes: ["read"] }),
  };
  const schemes: AuthScheme[] = [tokens()];
  const app = router({ auth: schemes });
  app.get("/", (c) => c.text(c.principal.subject));
  schemes.push(permissive);
  schemes[0] = permissive;
  assertStatus(await call(app, "/"), 401);
  assertEquals((await call(app, "/", { headers: as("reader") })).text, "ada");

  // A scheme's own members are read once, too: flipping `ambient` off
  // does not turn off the CSRF check, and swapping `authenticate` does
  // not change who gets in.
  const cookie: AuthScheme = {
    name: "cookie",
    ambient: true,
    authenticate: (c) =>
      c.req.headers.get("cookie") === "u=ada" ? { subject: "ada" } : null,
  };
  const site = router({ auth: cookie });
  site.post("/do", (c) => c.text("done"));
  loose(cookie).ambient = false;
  loose(cookie).authenticate = () => ({ subject: "mallory" });
  loose(cookie).name = "renamed";
  const forged = await call(site, "/do", {
    method: "POST",
    headers: { cookie: "u=ada", origin: "https://evil.example" },
  });
  assertStatus(forged, 403);
  assertStatus(await call(site, "/do", { method: "POST" }), 401);
});

Deno.test("scheme options are copied by the scheme factories", async () => {
  const options: { -readonly [K in keyof BearerOptions]: BearerOptions[K] } = {
    verify: ({ token }) => TOKENS[token] ?? null,
    allowQuery: false,
    allowBound: false,
    realm: "api",
  };
  const app = router({ auth: bearer(options) });
  app.get("/", (c) => c.text(c.principal.subject));
  options.allowQuery = true;
  options.verify = () => ({ subject: "mallory" });
  options.realm = "changed";
  assertStatus(await call(app, "/?access_token=reader"), 400);
  assertStatus(await call(app, "/", { headers: as("nobody") }), 401);
  assertHeader(await call(app, "/"), "www-authenticate", 'Bearer realm="api"');

  // Basic's cleartext switch moved to the router (DB-RTR-011): mutating
  // the router's options, and the public URL resolver, changes nothing.
  const basicOptions = {
    verify: (user: string) => user === "ada" ? { subject: "ada" } : null,
  };
  const publicUrl = {
    mode: "fixed" as const,
    origin: "http://api.example.com",
  };
  const plainOptions = {
    auth: basic(basicOptions),
    allowCleartextCredentialsForDevelopment: false,
    publicUrl,
  };
  const plain = router(plainOptions);
  plain.get("/", (c) => c.text("x"));
  plainOptions.allowCleartextCredentialsForDevelopment = true;
  (publicUrl as { origin: string }).origin = "https://api.example.com";
  const answer = await call(plain, "/", {
    origin: "http://api.example.com",
    headers: { authorization: `Basic ${btoa("ada:pw")}` },
  });
  assertStatus(answer, 403);

  const keyOptions = {
    lookup: (key: string) => key === "k-good" ? { subject: "ada" } : null,
  };
  const keyed = router({ auth: apiKey(keyOptions) });
  keyed.get("/", (c) => c.text("x"));
  keyOptions.lookup = () => ({ subject: "mallory" });
  assertStatus(
    await call(keyed, "/", { headers: { "x-api-key": "k-bad" } }),
    401,
  );

  const cookieOptions = { sameSite: "Strict" as "Strict" | "None" };
  const scheme = session({
    keys: [{ id: "k1", secret: "0123456789abcdef0123456789abcdef" }],
    cookieOptions,
  });
  const login = router({ auth: scheme });
  login.post("/login", { public: true, csrf: false }, async (c) => {
    await scheme.issue(c, { subject: "ada" });
    return c.text("in");
  });
  cookieOptions.sameSite = "None";
  const issued = await call(login, "/login", { method: "POST" });
  assert(
    issued.headers.get("set-cookie")!.includes("SameSite=Strict"),
    issued.headers.get("set-cookie")!,
  );
});

Deno.test("router cookies, client IP, security, CSRF and request id settings are copied", async () => {
  const cookies = { sameSite: "Strict" as "Strict" | "None", secure: true };
  const trustedProxies: string[] = [];
  const clientIp = { trustedProxies, forwardedHeader: "x-forwarded-for" };
  const security = { frameOptions: "DENY" as string | false };
  const trustedOrigins: string[] = [];
  const csrf = { trustedOrigins };
  const options: { -readonly [K in keyof RouterOptions]: RouterOptions[K] } = {
    auth: "none",
    cookies,
    clientIp,
    security,
    csrf,
    requestIdHeader: "x-request-id",
  };
  const app = router(options);
  app.get("/", (c) => {
    c.setCookie("pref", "1");
    return c.json({ ip: c.ip()?.toString() ?? null });
  });
  app.post("/do", { csrf: true }, (c) => c.text("done"));

  cookies.sameSite = "None";
  trustedProxies.push("0.0.0.0/0");
  clientIp.forwardedHeader = "x-client";
  security.frameOptions = false;
  trustedOrigins.push("https://evil.example");
  options.requestIdHeader = false;
  options.auth = [
    {
      name: "anyone",
      ambient: false,
      authenticate: () => ({ subject: "mallory" }),
    },
  ];

  const answer = await call(app, "/", {
    headers: {
      "cf-connecting-ip": "192.0.2.1",
      "x-forwarded-for": "203.0.113.9",
      "x-client": "203.0.113.9",
    },
  });
  assertEquals(answer.json, { ip: "192.0.2.1" });
  assert(
    answer.headers.get("set-cookie")!.includes("SameSite=Strict"),
    answer.headers.get("set-cookie")!,
  );
  assertHeader(answer, "x-frame-options", "DENY");
  assert(answer.headers.get("x-request-id") !== null, "request id header");
  const forged = await call(app, "/do", {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  assertStatus(forged, 403);
});

Deno.test("CORS options are copied when the middleware is made", async () => {
  const origins = ["https://app.example.com"];
  const exposeHeaders = ["x-request-id"];
  const methods = ["GET"];
  const options: { -readonly [K in keyof CorsOptions]: CorsOptions[K] } = {
    origins,
    exposeHeaders,
    methods,
    credentials: false,
  };
  const app = router({ auth: "none" }).use(cors(options));
  app.get("/", (c) => c.text("x"));
  app.delete("/", (c) => c.text("x"));
  origins.push("https://evil.example");
  exposeHeaders.push("x-secret");
  methods.push("DELETE");
  options.credentials = true;

  const evil = await call(app, "/", {
    headers: { origin: "https://evil.example" },
  });
  assertHeader(evil, "access-control-allow-origin", null);
  const good = await call(app, "/", {
    headers: { origin: "https://app.example.com" },
  });
  assertHeader(good, "access-control-allow-origin", "https://app.example.com");
  assertHeader(good, "access-control-expose-headers", "x-request-id");
  assertHeader(good, "access-control-allow-credentials", null);
  const preflight = await call(app, "/", {
    method: "OPTIONS",
    headers: {
      origin: "https://app.example.com",
      "access-control-request-method": "DELETE",
    },
  });
  assertStatus(preflight, 403);
});

Deno.test("routes() returns copies, not the router's own records", async () => {
  const scopes = ["admin"];
  const options: RouteOptions = { scopes, tags: ["a"] };
  const app = router({ auth: tokens() });
  app.get("/admin", options, (c) => c.text("admin"));
  const [info] = app.routes();
  assert(info.options !== options, "not the caller's options");
  assert(info.options.scopes !== scopes, "not the caller's scopes");
  assert(app.routes()[0] !== info, "a fresh copy per call");
  assert(app.routes()[0].options !== info.options, "fresh options per call");
  assert(app.routes()[0].segments !== info.segments, "fresh segments");
  assertEquals(info.options.scopes, ["admin"]);
  try {
    loose(info.options.scopes).length = 0;
    loose(info.options).public = true;
    loose(info.schemes).length = 0;
  } catch {
    // Frozen copies refuse the change; either way the router is unmoved.
  }
  assertStatus(await call(app, "/admin"), 401);
  assertStatus(await call(app, "/admin", { headers: as("reader") }), 403);
  assertEquals(app.routes()[0].options.scopes, ["admin"]);
});

Deno.test("route options are validated when they are copied", () => {
  const app = router({ auth: tokens() });
  const bad: [string, unknown][] = [
    ["scopes", ["a", 1]],
    ["scopes", "admin"],
    ["roles", [null]],
    ["public", "yes"],
    ["authorize", "nope"],
    ["use", [1]],
    ["before", "x"],
    ["tags", [2]],
    ["bodyType", "xml"],
    ["csrf", "on"],
  ];
  for (const [index, [key, value]] of bad.entries()) {
    let threw = false;
    try {
      app.get(`/${index}`, loose({ [key]: value }), (c) => c.text("x"));
    } catch (error) {
      threw = error instanceof Error && error.name === "RouterError";
    }
    assert(threw, `${key}: ${JSON.stringify(value)} is refused`);
  }
});
