// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "@celld/core/assert";
import { bearer, cors, router, RouterError } from "@celld/web/router";
import { assertHeader, assertMatch, assertStatus, call } from "./fixture.ts";

const SPA = "https://app.example.com";
const EVIL = "https://evil.example.net";

function api(credentials = false) {
  const app = router({
    auth: bearer({
      verify: ({ token }) => token === "t" ? { subject: "ada" } : null,
    }),
  }).use(cors({ origins: [SPA], credentials }));
  app.get("/me", (c) => c.json({ subject: c.principal.subject }));
  app.put("/me", (c) => c.text("updated"));
  app.get("/status", { public: true }, (c) => c.json({ ok: true }));
  return app;
}

function preflight(
  origin: string,
  method = "PUT",
  headers = "authorization, content-type",
) {
  return {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      "access-control-request-headers": headers,
    },
  };
}

Deno.test("without cors(), responses carry no CORS headers at all", async () => {
  const app = router({ auth: "none" });
  app.get("/", (c) => c.text("x"));
  const answer = await call(app, "/", { headers: { origin: SPA } });
  assertHeader(answer, "access-control-allow-origin", null);
  const pre = await call(app, "/", preflight(SPA, "GET"));
  assertStatus(pre, 204);
  assertHeader(pre, "access-control-allow-origin", null);
  assertHeader(pre, "allow", "GET, HEAD, OPTIONS");
});

Deno.test("without cors(), CORS headers set downstream are stripped by default", async () => {
  const app = router({ auth: "none" });
  app.get("/", (c) => {
    c.header("access-control-allow-credentials", "true");
    return new Response("x", {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "x-secret",
      },
    });
  });
  app.get("/boom", () => {
    throw new Error("boom");
  });
  const answer = await call(app, "/", { headers: { origin: EVIL } });
  assertStatus(answer, 200);
  for (
    const name of [
      "access-control-allow-origin",
      "access-control-allow-credentials",
      "access-control-expose-headers",
    ]
  ) {
    assertHeader(answer, name, null);
  }

  const passthrough = router({ auth: "none", cors: "passthrough" });
  passthrough.get(
    "/",
    () =>
      new Response("x", { headers: { "access-control-allow-origin": "*" } }),
  );
  assertHeader(
    await call(passthrough, "/", { headers: { origin: EVIL } }),
    "access-control-allow-origin",
    "*",
  );
  assertThrows(
    () => router({ auth: "none", cors: "pass" as "passthrough" }),
    RouterError,
    "cors",
  );
});

Deno.test("an allowed origin's preflight is answered before authentication", async () => {
  const answer = await call(api(), "/me", preflight(SPA));
  assertStatus(answer, 204);
  assertHeader(answer, "access-control-allow-origin", SPA);
  assertHeader(
    answer,
    "access-control-allow-methods",
    "GET, HEAD, POST, PUT, PATCH, DELETE",
  );
  assertHeader(
    answer,
    "access-control-allow-headers",
    "content-type, authorization",
  );
  assertHeader(answer, "access-control-max-age", "600");
  assertHeader(answer, "access-control-allow-credentials", null);
  assertHeader(
    answer,
    "vary",
    "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  );
});

Deno.test("another origin's preflight is refused and never reflected", async () => {
  const answer = await call(api(), "/me", preflight(EVIL));
  assertStatus(answer, 403);
  assertHeader(answer, "access-control-allow-origin", null);
  assertHeader(answer, "vary", "Origin");
  assertMatch(answer.json, { error: "cors" });
});

Deno.test("a preflight for a method or header not allowed is refused", async () => {
  assertStatus(await call(api(), "/me", preflight(SPA, "PROPFIND")), 403);
  const header = await call(api(), "/me", preflight(SPA, "PUT", "x-secret"));
  assertStatus(header, 403);
  assertMatch(header.json, {
    message: "the cross-origin request is not allowed",
  });
});

Deno.test("actual requests: allowed origins get CORS headers, 401s included", async () => {
  const ok = await call(api(), "/me", {
    headers: { origin: SPA, authorization: "Bearer t" },
  });
  assertEquals(ok.json, { subject: "ada" });
  assertHeader(ok, "access-control-allow-origin", SPA);
  assertHeader(ok, "access-control-expose-headers", "x-request-id");
  // An authenticated answer varies by the credentials too (DB-REV-RTR-6).
  assertHeader(ok, "vary", "Origin, Authorization, Cookie");
  const unauthorized = await call(api(), "/me", { headers: { origin: SPA } });
  assertStatus(unauthorized, 401);
  assertHeader(unauthorized, "access-control-allow-origin", SPA);
  const missing = await call(api(), "/nope", { headers: { origin: SPA } });
  assertStatus(missing, 404);
  assertHeader(missing, "access-control-allow-origin", SPA);
});

Deno.test("actual requests from other origins get Vary but no allow header", async () => {
  const answer = await call(api(), "/status", { headers: { origin: EVIL } });
  assertStatus(answer, 200);
  assertHeader(answer, "access-control-allow-origin", null);
  assertHeader(answer, "vary", "Origin");
  const nullOrigin = await call(api(), "/status", {
    headers: { origin: "null" },
  });
  assertHeader(nullOrigin, "access-control-allow-origin", null);
});

Deno.test("credentials: only listed origins, echoed exactly, with Allow-Credentials", async () => {
  const answer = await call(api(true), "/me", {
    headers: { origin: SPA, authorization: "Bearer t" },
  });
  assertHeader(answer, "access-control-allow-origin", SPA);
  assertHeader(answer, "access-control-allow-credentials", "true");
  const evil = await call(api(true), "/me", {
    headers: { origin: EVIL, authorization: "Bearer t" },
  });
  assertHeader(evil, "access-control-allow-origin", null);
  assertHeader(evil, "access-control-allow-credentials", null);
});

Deno.test('"*" allows any origin without credentials, and refuses them', async () => {
  const app = router({ auth: "none" }).use(cors({ origins: "*" }));
  app.get("/", (c) => c.text("x"));
  assertHeader(
    await call(app, "/", { headers: { origin: EVIL } }),
    "access-control-allow-origin",
    "*",
  );
  assertThrows(
    () => cors({ origins: "*", credentials: true }),
    RouterError,
    "not *",
  );
});

Deno.test("origins are checked at setup: no paths, slashes or null", () => {
  assertThrows(
    () => cors({ origins: ["https://app.example.com/"] }),
    RouterError,
    "no path",
  );
  assertThrows(
    () => cors({ origins: ["app.example.com"] }),
    RouterError,
    "not an origin",
  );
  assertThrows(() => cors({ origins: ["null"] }), RouterError, "not an origin");
});

Deno.test("a predicate decides per request", async () => {
  const app = router({ auth: "none" }).use(
    cors({
      origins: (origin) =>
        origin.endsWith(".example.com") && origin.startsWith("https://"),
    }),
  );
  app.get("/", (c) => c.text("x"));
  assertHeader(
    await call(app, "/", { headers: { origin: "https://a.example.com" } }),
    "access-control-allow-origin",
    "https://a.example.com",
  );
  assertHeader(
    await call(app, "/", { headers: { origin: "http://a.example.com" } }),
    "access-control-allow-origin",
    null,
  );
});

// DB-RTR-005: the policy has the last word on every CORS header.

const HOSTILE = {
  "access-control-allow-origin": "*",
  "access-control-allow-credentials": "true",
  "access-control-expose-headers": "x-secret",
  "access-control-allow-methods": "DELETE",
  "access-control-allow-headers": "x-anything",
  "access-control-max-age": "99999",
  "access-control-allow-private-network": "true",
};

class Mapped extends Error {}

/** A stand-in for an upstream service whose answers carry its own CORS headers. */
function upstream(): Promise<Response> {
  return Promise.resolve(
    new Response("from upstream", {
      headers: { ...HOSTILE, vary: "Accept-Encoding" },
    }),
  );
}

function hostileApp() {
  const app = router({
    auth: "none",
    mapError: (error) =>
      error instanceof Mapped
        ? new Response("mapped", { status: 502, headers: HOSTILE })
        : null,
  })
    // Router middleware outside cors() that meddles with the answer.
    .use(async (c, next) => {
      const response = await next();
      if (c.req.headers.get("x-meddle") === null) return response;
      const out = new Response(response.body, response);
      out.headers.set("access-control-allow-origin", "*");
      out.headers.set("access-control-allow-methods", "TRACE");
      return out;
    })
    .use(cors({ origins: [SPA], credentials: true }));
  app.get("/handler", () => new Response("x", { headers: HOSTILE }));
  app.get("/header", (c) => {
    c.header("access-control-allow-origin", EVIL);
    c.header("access-control-allow-credentials", "true");
    c.header("access-control-expose-headers", "x-secret");
    c.header("access-control-max-age", "99999");
    return c.text("x");
  });
  app.get("/mapped", () => {
    throw new Mapped("upstream failed");
  });
  app.get("/proxy", () => upstream());
  app.get("/thrown", (c) => {
    c.header("access-control-allow-origin", "*");
    throw new Error("boom");
  });
  return app;
}

const CORS_NAMES = [
  ...Object.keys(HOSTILE),
];

function corsHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (name.startsWith("access-control-")) out[name] = value;
  }
  return out;
}

function varies(headers: Headers, name: string): boolean {
  return (headers.get("vary") ?? "").toLowerCase().split(",").map((v) =>
    v.trim()
  ).includes(name.toLowerCase());
}

Deno.test("an allowed origin gets exactly the policy's CORS headers, whatever the route set", async () => {
  const app = hostileApp();
  for (const path of ["/handler", "/header", "/mapped", "/proxy", "/thrown"]) {
    for (const meddle of [false, true]) {
      const answer = await call(app, path, {
        headers: { origin: SPA, ...(meddle ? { "x-meddle": "1" } : {}) },
      });
      assertEquals(corsHeaders(answer.headers), {
        "access-control-allow-origin": SPA,
        "access-control-allow-credentials": "true",
        "access-control-expose-headers": "x-request-id",
      }, `${path}${meddle ? " (meddled)" : ""}`);
      assertEquals(varies(answer.headers, "Origin"), true, `${path} Vary`);
    }
  }
  // The upstream's own Vary entries survive next to Origin.
  const proxied = await call(app, "/proxy", { headers: { origin: SPA } });
  assertEquals(varies(proxied.headers, "Accept-Encoding"), true);
});

Deno.test("a disallowed or missing origin gets no CORS headers, whatever the route set", async () => {
  const app = hostileApp();
  for (const path of ["/handler", "/header", "/mapped", "/proxy", "/thrown"]) {
    for (const origin of [EVIL, "null", undefined]) {
      for (const meddle of [false, true]) {
        const answer = await call(app, path, {
          headers: {
            ...(origin === undefined ? {} : { origin }),
            ...(meddle ? { "x-meddle": "1" } : {}),
          },
        });
        assertEquals(
          corsHeaders(answer.headers),
          {},
          `${path} from ${origin}${meddle ? " (meddled)" : ""}`,
        );
        for (const name of CORS_NAMES) assertHeader(answer, name, null);
        assertEquals(varies(answer.headers, "Origin"), true, `${path} Vary`);
      }
    }
  }
});

Deno.test("preflights keep exactly the policy's headers, even when outer middleware meddles", async () => {
  const app = hostileApp();
  const allowed = await call(app, "/handler", {
    method: "OPTIONS",
    headers: {
      origin: SPA,
      "access-control-request-method": "GET",
      "x-meddle": "1",
    },
  });
  assertStatus(allowed, 204);
  assertEquals(corsHeaders(allowed.headers), {
    "access-control-allow-origin": SPA,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "600",
  });
  const refused = await call(app, "/handler", {
    method: "OPTIONS",
    headers: {
      origin: EVIL,
      "access-control-request-method": "GET",
      "x-meddle": "1",
    },
  });
  assertStatus(refused, 403);
  assertEquals(corsHeaders(refused.headers), {});
});

// DB-REV-RTR-7: nested `cors()` policies intersect. An inner one (a
// mounted router's) can narrow what the outer one grants, never widen it:
// an origin is granted only when every `cors()` the request passed allows
// it, and credentials only when every one sends them.
Deno.test("an inner cors() cannot widen the serving router's allowlist", async () => {
  const child = router({ auth: "none" });
  child.use(cors({ origins: "*" }));
  child.get("/data", (c) => c.text("data"));
  const app = router({ auth: "none" });
  app.use(cors({ origins: [SPA] }));
  app.mount("/v1", child);
  const evil = await call(app, "/v1/data", { headers: { origin: EVIL } });
  assertHeader(evil, "access-control-allow-origin", null);
  const spa = await call(app, "/v1/data", { headers: { origin: SPA } });
  assertHeader(spa, "access-control-allow-origin", SPA);
  // Narrowing works: the inner list refuses what the outer allows.
  const strict = router({ auth: "none" });
  strict.use(cors({ origins: ["https://other.example.com"] }));
  strict.get("/data", (c) => c.text("data"));
  const open = router({ auth: "none" });
  open.use(cors({ origins: "*" }));
  open.mount("/v1", strict);
  assertHeader(
    await call(open, "/v1/data", { headers: { origin: SPA } }),
    "access-control-allow-origin",
    null,
  );
  // Credentials only when every policy sends them.
  const withCredentials = router({ auth: "none" });
  withCredentials.use(cors({ origins: [SPA], credentials: true }));
  withCredentials.get("/data", (c) => c.text("data"));
  const plain = router({ auth: "none" });
  plain.use(cors({ origins: [SPA] }));
  plain.mount("/v1", withCredentials);
  const answer = await call(plain, "/v1/data", { headers: { origin: SPA } });
  assertHeader(answer, "access-control-allow-origin", SPA);
  assertHeader(answer, "access-control-allow-credentials", null);
});
