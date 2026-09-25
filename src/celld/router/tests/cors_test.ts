// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "@celld/assert";
import { bearer, cors, router, RouterError } from "@celld/router";
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
    message: "header x-secret is not allowed cross-origin",
  });
});

Deno.test("actual requests: allowed origins get CORS headers, 401s included", async () => {
  const ok = await call(api(), "/me", {
    headers: { origin: SPA, authorization: "Bearer t" },
  });
  assertEquals(ok.json, { subject: "ada" });
  assertHeader(ok, "access-control-allow-origin", SPA);
  assertHeader(ok, "access-control-expose-headers", "x-request-id");
  assertHeader(ok, "vary", "Origin");
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
