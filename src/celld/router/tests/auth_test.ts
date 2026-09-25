// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import {
  AuthError,
  type AuthScheme,
  bearer,
  dpop,
  type PrincipalInput,
  router,
  RouterError,
} from "@celld/router";
import { assertHeader, assertMatch, assertStatus, call } from "./fixture.ts";

const TOKENS: Record<string, PrincipalInput> = {
  reader: { subject: "ada", scopes: ["notes:read"], roles: ["viewer"] },
  writer: {
    subject: "bob",
    scopes: ["notes:read", "notes:write"],
    roles: ["editor"],
  },
  admin: {
    subject: "cy",
    scopes: ["notes:read"],
    roles: ["admin"],
    tenant: "t1",
  },
};

const tokens = bearer({
  verify: ({ token }) => TOKENS[token] ?? null,
  realm: "notes",
});

function bearerHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

Deno.test("a router without auth refuses a route that is not public, when it is added", () => {
  const app = router();
  app.get("/health", { public: true }, (c) => c.text("ok"));
  const error = assertThrows(
    () => app.get("/notes", (c) => c.text("secret")),
    RouterError,
    "GET /notes is not public and its router has no auth",
  );
  assert(
    error.message.includes('router({ auth: "none" })'),
    "the message says how to opt out",
  );
});

Deno.test('auth: "none" is the explicit opt-out, and forbids scopes', async () => {
  const app = router({ auth: "none" });
  app.get("/notes", (c) => c.json({ principal: c.principal }));
  assertEquals((await call(app, "/notes")).json, { principal: null });
  assertThrows(
    () => app.get("/admin", { scopes: ["admin"] }, (c) => c.text("x")),
    RouterError,
    'auth is "none"',
  );
});

Deno.test("public routes cannot ask for scopes or roles", () => {
  const app = router({ auth: tokens });
  assertThrows(
    () => app.get("/x", { public: true, roles: ["admin"] }, (c) => c.text("x")),
    RouterError,
    "is public but asks for",
  );
});

Deno.test("with auth, every route needs a principal unless public", async () => {
  const app = router({ auth: tokens });
  app.get("/notes", (c) => c.json({ subject: c.principal.subject }));
  app.get(
    "/health",
    { public: true },
    (c) => c.json({ principal: c.principal?.subject ?? null }),
  );

  const anonymous = await call(app, "/notes");
  assertStatus(anonymous, 401);
  assertHeader(anonymous, "www-authenticate", 'Bearer realm="notes"');
  assertMatch(anonymous.json, {
    error: "unauthorized",
    message: "authentication required",
  });

  assertEquals(
    (await call(app, "/notes", { headers: bearerHeader("reader") })).json,
    {
      subject: "ada",
    },
  );
  assertEquals((await call(app, "/health")).json, { principal: null });
  assertEquals(
    (await call(app, "/health", { headers: bearerHeader("writer") })).json,
    {
      principal: "bob",
    },
  );
});

Deno.test("a bad credential is refused even on a public route; it never becomes anonymous", async () => {
  const app = router({ auth: tokens });
  app.get("/health", { public: true }, (c) => c.text("ok"));
  const answer = await call(app, "/health", {
    headers: bearerHeader("forged"),
  });
  assertStatus(answer, 401);
  assertHeader(
    answer,
    "www-authenticate",
    'Bearer realm="notes", error="invalid_token", error_description="the access token is not valid"',
  );
});

Deno.test("scopes are all required; the 403 names them in the challenge", async () => {
  const app = router({ auth: tokens });
  app.post(
    "/notes",
    { scopes: ["notes:read", "notes:write"] },
    (c) => c.text("made", 201),
  );
  assertStatus(
    await call(app, "/notes", {
      method: "POST",
      headers: bearerHeader("writer"),
    }),
    201,
  );
  const denied = await call(app, "/notes", {
    method: "POST",
    headers: bearerHeader("reader"),
  });
  assertStatus(denied, 403);
  assertHeader(
    denied,
    "www-authenticate",
    'Bearer realm="notes", error="insufficient_scope", error_description="this needs the scopes: notes:read notes:write", scope="notes:read notes:write"',
  );
  assertMatch(denied.json, { error: "insufficient_scope" });
  assertHeader(denied, "cache-control", "no-store");
});

Deno.test("roles need any one; authorize is a predicate", async () => {
  const app = router({ auth: tokens });
  app.get("/edit", { roles: ["editor", "admin"] }, (c) => c.text("edit"));
  app.get("/tenant/:id", {
    authorize: (principal, c) => principal.tenant === c.params.id,
  }, (c) => c.text("tenant"));
  assertStatus(
    await call(app, "/edit", { headers: bearerHeader("writer") }),
    200,
  );
  assertStatus(
    await call(app, "/edit", { headers: bearerHeader("admin") }),
    200,
  );
  const viewer = await call(app, "/edit", { headers: bearerHeader("reader") });
  assertStatus(viewer, 403);
  assertMatch(viewer.json, {
    error: "forbidden",
    message: "this needs one of the roles: editor, admin",
  });
  assertHeader(viewer, "www-authenticate", null);
  assertStatus(
    await call(app, "/tenant/t1", { headers: bearerHeader("admin") }),
    200,
  );
  assertStatus(
    await call(app, "/tenant/t2", { headers: bearerHeader("admin") }),
    403,
  );
});

function scheme(
  name: string,
  outcome: (c: Request) => ReturnType<AuthScheme["authenticate"]>,
): AuthScheme {
  return {
    name,
    authenticate: (c) => outcome(c.req),
    challenge: (error) => ({
      scheme: name,
      params: error === undefined ? [] : [["error", error.code]],
    }),
  };
}

Deno.test("schemes are tried in order; the first principal wins", async () => {
  const seen: string[] = [];
  const first = scheme("First", (req) => {
    seen.push("first");
    return req.headers.has("x-first") ? { subject: "one" } : null;
  });
  const second = scheme("Second", (req) => {
    seen.push("second");
    return req.headers.has("x-second") ? { subject: "two" } : null;
  });
  const app = router({ auth: [first, second] });
  app.get(
    "/",
    (c) => c.json({ subject: c.principal.subject, scheme: c.principal.scheme }),
  );
  assertEquals((await call(app, "/", { headers: { "x-second": "1" } })).json, {
    subject: "two",
    scheme: "Second",
  });
  assertEquals(seen, ["first", "second"]);
  seen.length = 0;
  assertEquals(
    (await call(app, "/", { headers: { "x-first": "1", "x-second": "1" } }))
      .json,
    {
      subject: "one",
      scheme: "First",
    },
  );
  assertEquals(seen, ["first"]);
  const none = await call(app, "/");
  assertStatus(none, 401);
  assertHeader(none, "www-authenticate", "First, Second");
});

Deno.test("a failing scheme stops the chain with its own challenge only", async () => {
  const failing = scheme(
    "First",
    (req) =>
      req.headers.has("x-first") ? new AuthError("invalid_token", "") : null,
  );
  const fallback = scheme("Second", () => ({ subject: "anyone" }));
  const app = router({ auth: [failing, fallback] });
  app.get("/", (c) => c.text(c.principal.subject));
  const answer = await call(app, "/", { headers: { "x-first": "1" } });
  assertStatus(answer, 401);
  assertHeader(answer, "www-authenticate", 'First error="invalid_token"');
  assertEquals((await call(app, "/")).text, "anyone");
});

Deno.test("a scheme may throw an AuthError; other exceptions are opaque 500s", async () => {
  const thrower = scheme("T", (req) => {
    if (req.headers.has("x-auth")) {
      throw new AuthError("invalid_request", "bad", { status: 400 });
    }
    throw new Error("database password is hunter2");
  });
  const app = router({ auth: thrower });
  app.get("/", (c) => c.text("x"));
  const refused = await call(app, "/", { headers: { "x-auth": "1" } });
  assertStatus(refused, 400);
  assertHeader(refused, "www-authenticate", 'T error="invalid_request"');
  const crashed = await call(app, "/");
  assertStatus(crashed, 500);
  assert(!crashed.text.includes("hunter2"), "the message does not leak");
});

Deno.test("a principal without a subject is a server error, not a login", async () => {
  const broken = scheme("B", () => ({ subject: "" }));
  const app = router({ auth: broken });
  app.get("/", (c) => c.text("x"));
  assertStatus(await call(app, "/"), 500);
});

Deno.test("principals are frozen and complete", async () => {
  const app = router({ auth: tokens });
  app.get("/", (c) => {
    assert(Object.isFrozen(c.principal), "frozen");
    assert(Object.isFrozen(c.principal.scopes), "scopes frozen");
    return c.json(c.principal);
  });
  assertEquals(
    (await call(app, "/", { headers: bearerHeader("admin") })).json,
    {
      subject: "cy",
      scopes: ["notes:read"],
      roles: ["admin"],
      claims: {},
      scheme: "bearer",
      tenant: "t1",
    },
  );
});

Deno.test("two schemes with one name are refused", () => {
  assertThrows(
    () => router({ auth: [tokens, tokens] }),
    RouterError,
    "two auth schemes",
  );
  assertThrows(() => router({ auth: [] }), RouterError, "at least one scheme");
});

Deno.test('a router with auth "inherit" takes its parent\'s auth when mounted', async () => {
  const app = router({ auth: tokens });
  const notes = router({ auth: "inherit" });
  notes.get(
    "/",
    { scopes: ["notes:read"] },
    (c) => c.text(`notes of ${c.principal.subject}`),
  );
  app.mount("/notes", notes);
  assertStatus(await call(app, "/notes"), 401);
  assertEquals(
    (await call(app, "/notes", { headers: bearerHeader("reader") })).text,
    "notes of ada",
  );
});

Deno.test("mounting an inheriting router into one without auth fails at mount", () => {
  const app = router();
  const notes = router({ auth: "inherit" });
  notes.get("/", (c) => c.text("secret"));
  assertThrows(
    () => app.mount("/notes", notes),
    RouterError,
    "GET /notes is not public",
  );
  const lone = router({ auth: "inherit" });
  lone.get("/", (c) => c.text("x"));
  assertThrows(() => lone.routes(), RouterError, "must be mounted");
});

Deno.test("a mounted router keeps its own auth", async () => {
  const app = router({ auth: tokens });
  const hooks = router({ auth: "none" });
  hooks.post("/ping", (c) => c.text("pong"));
  app.mount("/hooks", hooks);
  assertEquals(
    (await call(app, "/hooks/ping", { method: "POST" })).text,
    "pong",
  );
});

// AuthErrors thrown after authentication

const META = "https://api.example.com/.well-known/oauth-protected-resource";

function stepUpApp() {
  const scheme = bearer({
    verify: ({ token }) =>
      token === "nonce"
        ? { ...TOKENS.reader, headers: { "dpop-nonce": "n-fresh" } }
        : TOKENS[token] ?? null,
    realm: "notes",
    resourceMetadata: META,
  });
  const app = router({ auth: scheme });
  const needs = (scope: string) => {
    throw new AuthError(
      "insufficient_scope",
      `this tool needs ${scope}`,
      { scope: [scope] },
    );
  };
  app.post("/tools", async (c) => {
    const { tool } = await c.readJson() as { tool: string };
    if (tool === "write" && !c.principal.scopes.includes("notes:write")) {
      needs("notes:write");
    }
    return c.json({ ran: tool });
  });
  app.get("/guarded", {
    use: [(c) => {
      if (c.principal.subject !== "bob") needs("notes:admin");
      throw new Error("unreachable");
    }],
  }, (c) => c.text("x"));
  app.get("/check", {
    authorize: () => needs("notes:audit"),
  }, (c) => c.text("x"));
  return app;
}

Deno.test("an AuthError from a handler gets the authenticating scheme's challenge", async () => {
  const app = stepUpApp();
  const denied = await call(app, "/tools", {
    json: { tool: "write" },
    headers: bearerHeader("reader"),
  });
  assertStatus(denied, 403);
  assertMatch(denied.json, {
    error: "insufficient_scope",
    message: "this tool needs notes:write",
  });
  assertHeader(
    denied,
    "www-authenticate",
    `Bearer realm="notes", error="insufficient_scope", error_description="this tool needs notes:write", scope="notes:write", resource_metadata="${META}"`,
  );
  assertHeader(denied, "cache-control", "no-store");
  assertEquals(
    (await call(app, "/tools", {
      json: { tool: "write" },
      headers: bearerHeader("writer"),
    })).json,
    { ran: "write" },
  );
});

Deno.test("an AuthError from route middleware or authorize gets the challenge too", async () => {
  const app = stepUpApp();
  for (
    const [path, scope] of [["/guarded", "notes:admin"], [
      "/check",
      "notes:audit",
    ]]
  ) {
    const denied = await call(app, path, { headers: bearerHeader("reader") });
    assertStatus(denied, 403);
    assertHeader(
      denied,
      "www-authenticate",
      `Bearer realm="notes", error="insufficient_scope", error_description="this tool needs ${scope}", scope="${scope}", resource_metadata="${META}"`,
    );
  }
});

Deno.test("headers auth produced survive an AuthError from the handler", async () => {
  const app = stepUpApp();
  const denied = await call(app, "/tools", {
    json: { tool: "write" },
    headers: bearerHeader("nonce"),
  });
  assertStatus(denied, 403);
  assertHeader(denied, "dpop-nonce", "n-fresh");
  assert(
    denied.headers.get("www-authenticate")!.includes('scope="notes:write"'),
    "the challenge is there",
  );
});

Deno.test("an anonymous request's AuthError challenges with every route scheme, without error details (RFC 6750 3.1)", async () => {
  const other = scheme("Other", () => null);
  const tokens = bearer({
    verify: () => null,
    realm: "notes",
    resourceMetadata: META,
  });
  const app = router({ auth: [tokens, other] });
  app.get("/open", { public: true }, () => {
    throw new AuthError("invalid_token", "sign in to see this", {
      headers: { "x-hint": "login" },
    });
  });
  const answer = await call(app, "/open");
  assertStatus(answer, 401);
  assertHeader(answer, "x-hint", "login");
  assertHeader(
    answer,
    "www-authenticate",
    `Bearer realm="notes", resource_metadata="${META}", Other`,
  );
  assertHeader(answer, "cache-control", "no-store");
});

Deno.test("the challenge comes from the scheme that authenticated, in its own syntax", async () => {
  const proofs = dpop({
    verify: () => ({ subject: "ada", cnf: { jkt: "thumb" } }),
    realm: "api",
    resourceMetadata: META,
  });
  const app = router({ auth: [bearer({ verify: () => null }), proofs] });
  app.get("/", () => {
    throw new AuthError("insufficient_scope", "", { scope: ["a", "b"] });
  });
  const answer = await call(app, "/", {
    headers: {
      authorization: "DPoP bound",
      dpop: "eyJhbGciOiJFUzI1NiJ9.eyJodG0iOiJHRVQifQ.c2ln",
    },
  });
  assertStatus(answer, 403);
  assertHeader(
    answer,
    "www-authenticate",
    `DPoP realm="api", algs="ES256 RS256 PS256", error="insufficient_scope", scope="a b", resource_metadata="${META}"`,
  );
});

Deno.test('with auth "none" or before a route matches, an AuthError has no challenge', async () => {
  const open = router({ auth: "none" });
  open.get("/", () => {
    throw new AuthError("forbidden", "no", { headers: { "x-why": "because" } });
  });
  const answer = await call(open, "/");
  assertStatus(answer, 403);
  assertHeader(answer, "www-authenticate", null);
  assertHeader(answer, "x-why", "because");
  assertMatch(answer.json, { error: "forbidden", message: "no" });

  const early = router({ auth: tokens });
  early.use(() => {
    throw new AuthError("invalid_token", "early");
  });
  early.get("/", (c) => c.text("x"));
  const refused = await call(early, "/");
  assertStatus(refused, 401);
  assertHeader(refused, "www-authenticate", null);
});

// unauthenticated

function loginScheme(
  name: string,
  seen: string[],
  answer: (c: { req: Request }) => Response | null | undefined,
): AuthScheme {
  return {
    name,
    ambient: true,
    authenticate: (c) => {
      const user = c.req.headers.get(`x-${name}-user`);
      if (user === "") return new AuthError("invalid_credentials", "empty");
      return user === null ? null : { subject: user };
    },
    challenge: (error) =>
      error === undefined ? { scheme: name } : {
        scheme: name,
        params: [["error", error.code]],
      },
    unauthenticated: (c) => {
      seen.push(name);
      return answer(c);
    },
  };
}

const wantsHtml = (req: Request) =>
  (req.method === "GET" || req.method === "HEAD") &&
  (req.headers.get("accept") ?? "").includes("text/html");

Deno.test("a scheme's unauthenticated answers in place of the 401", async () => {
  const seen: string[] = [];
  const exe = loginScheme(
    "exe",
    seen,
    (c) =>
      wantsHtml(c.req)
        ? new Response(null, {
          status: 302,
          headers: { location: "/__login?redirect=%2Fdash" },
        })
        : null,
  );
  const app = router({ auth: exe });
  app.get("/dash", (c) => c.html(`<p>${c.principal.subject}</p>`));

  const browser = await call(app, "/dash", {
    headers: { accept: "text/html,*/*" },
  });
  assertStatus(browser, 302);
  assertHeader(browser, "location", "/__login?redirect=%2Fdash");
  assertHeader(browser, "x-content-type-options", "nosniff");
  assertHeader(browser, "x-frame-options", "DENY");
  assertHeader(browser, "cache-control", "no-store");
  assert(browser.headers.has("x-request-id"), "the request id is set");

  const script = await call(app, "/dash", {
    headers: { accept: "application/json" },
  });
  assertStatus(script, 401);
  assertHeader(script, "www-authenticate", "exe");
  assertMatch(script.json, { error: "unauthorized" });

  assertStatus(
    await call(app, "/dash", { headers: { "x-exe-user": "ada" } }),
    200,
  );
  assertEquals(seen, ["exe", "exe"]);
});

Deno.test("the first scheme, in order, whose unauthenticated returns a Response wins", async () => {
  const seen: string[] = [];
  const first = loginScheme("first", seen, () => null);
  const second = loginScheme(
    "second",
    seen,
    () => new Response("second", { status: 302, headers: { location: "/b" } }),
  );
  const third = loginScheme(
    "third",
    seen,
    () => new Response("third", { status: 302, headers: { location: "/c" } }),
  );
  const app = router({ auth: [first, second, third] });
  app.get("/", (c) => c.text("x"));
  const answer = await call(app, "/");
  assertStatus(answer, 302);
  assertHeader(answer, "location", "/b");
  assertEquals(seen, ["first", "second"]);
});

Deno.test("unauthenticated is not asked about a refused credential, nor on public routes", async () => {
  const seen: string[] = [];
  const exe = loginScheme(
    "exe",
    seen,
    () => new Response(null, { status: 302, headers: { location: "/login" } }),
  );
  const app = router({ auth: [exe, tokens] });
  app.get("/", (c) => c.text("x"));
  app.get("/health", { public: true }, (c) => c.text("ok"));

  const refused = await call(app, "/", { headers: { "x-exe-user": "" } });
  assertStatus(refused, 401);
  assertHeader(refused, "www-authenticate", 'exe error="invalid_credentials"');
  const forged = await call(app, "/", { headers: bearerHeader("forged") });
  assertStatus(forged, 401);
  const malformed = await call(app, "/?access_token=a", {
    headers: bearerHeader("reader"),
  });
  assertStatus(malformed, 400);
  assertEquals((await call(app, "/health")).text, "ok");
  assertEquals(seen, []);
});

Deno.test("an unauthenticated answer gets c.header's headers; a bad return is a 500", async () => {
  const exe = loginScheme("exe", [], (c) => {
    return c.req.headers.has("x-broken")
      ? "nope" as unknown as Response
      : new Response(null, { status: 302, headers: { location: "/login" } });
  });
  const app = router({ auth: exe });
  app.use(async (c, next) => {
    c.header("x-trace", "t1");
    return await next();
  });
  app.get("/", (c) => c.text("x"));
  const answer = await call(app, "/");
  assertStatus(answer, 302);
  assertHeader(answer, "x-trace", "t1");
  assertStatus(await call(app, "/", { headers: { "x-broken": "1" } }), 500);
});
