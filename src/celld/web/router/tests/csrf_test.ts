// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import {
  type AuthScheme,
  bearer,
  csrfToken,
  router,
  RouterError,
  type RouterOptions,
} from "@celld/web/router";
import { v } from "@celld/sieve";
import { assertMatch, assertStatus, call } from "./fixture.ts";

const cookieScheme: AuthScheme = {
  name: "cookie",
  ambient: true,
  authenticate: (c) => c.cookie("sid") === "s1" ? { subject: "ada" } : null,
};

function app(options: Omit<RouterOptions, "auth"> = {}) {
  const app = router({
    auth: [
      cookieScheme,
      bearer({
        verify: ({ token }) => token === "t" ? { subject: "api" } : null,
      }),
    ],
    ...options,
  });
  app.post("/transfer", (c) => c.text(`sent by ${c.principal.subject}`));
  app.get("/balance", (c) => c.text("100"));
  app.post("/webhook", { csrf: false }, (c) => c.text("hooked"));
  // Forcing a check under `csrf: false` is a registration error (DB-RTR-012).
  if (options.csrf !== false) {
    app.post("/login", { public: true, csrf: true }, (c) => c.text("login"));
  }
  app.post("/form", {
    bodyType: "form",
    body: v.strictObject({ amount: v.string() }),
  }, (c) => c.text(`form ${c.body.amount}`));
  app.get("/token", (c) => c.text(csrfToken(c)));
  return app;
}

const SESSION = { cookie: "sid=s1" };

Deno.test("cross-site POSTs with a cookie are refused (Sec-Fetch-Site)", async () => {
  const answer = await call(app(), "/transfer", {
    method: "POST",
    headers: {
      ...SESSION,
      "sec-fetch-site": "cross-site",
      origin: "https://evil.example.net",
    },
  });
  assertStatus(answer, 403);
  assertMatch(answer.json, {
    error: "csrf",
    message: "cross-site request refused (Sec-Fetch-Site: cross-site)",
  });
  const sameSite = await call(app(), "/transfer", {
    method: "POST",
    headers: { ...SESSION, "sec-fetch-site": "same-site" },
  });
  assertStatus(sameSite, 403);
});

Deno.test("same-origin and user-initiated requests pass", async () => {
  for (const site of ["same-origin", "none"]) {
    const answer = await call(app(), "/transfer", {
      method: "POST",
      headers: { ...SESSION, "sec-fetch-site": site },
    });
    assertEquals(answer.text, "sent by ada");
  }
});

Deno.test("without Sec-Fetch-Site, Origin must be this origin", async () => {
  const evil = await call(app(), "/transfer", {
    method: "POST",
    headers: { ...SESSION, origin: "https://evil.example.net" },
  });
  assertStatus(evil, 403);
  assertMatch(evil.json, {
    message: "cross-site request refused (Origin: https://evil.example.net)",
  });
  assertStatus(
    await call(app(), "/transfer", {
      method: "POST",
      headers: { ...SESSION, origin: "null" },
    }),
    403,
  );
  const same = await call(app(), "/transfer", {
    method: "POST",
    headers: { ...SESSION, origin: "https://api.example.com" },
  });
  assertStatus(same, 200);
});

Deno.test("requests with neither header are not from a browser and pass", async () => {
  assertStatus(
    await call(app(), "/transfer", { method: "POST", headers: SESSION }),
    200,
  );
});

Deno.test("safe methods and non-ambient credentials are never checked", async () => {
  const cross = {
    "sec-fetch-site": "cross-site",
    origin: "https://evil.example.net",
  };
  assertStatus(
    await call(app(), "/balance", { headers: { ...SESSION, ...cross } }),
    200,
  );
  const bearerPost = await call(app(), "/transfer", {
    method: "POST",
    headers: { authorization: "Bearer t", ...cross },
  });
  assertEquals(bearerPost.text, "sent by api");
});

Deno.test("trusted origins pass; csrf: false relaxes a route; csrf: true forces it", async () => {
  const trusting = app({
    csrf: { trustedOrigins: ["https://admin.example.com"] },
  });
  assertStatus(
    await call(trusting, "/transfer", {
      method: "POST",
      headers: {
        ...SESSION,
        "sec-fetch-site": "same-site",
        origin: "https://admin.example.com",
      },
    }),
    200,
  );
  const cross = {
    "sec-fetch-site": "cross-site",
    origin: "https://evil.example.net",
  };
  assertStatus(
    await call(app(), "/webhook", {
      method: "POST",
      headers: { ...SESSION, ...cross },
    }),
    200,
  );
  assertStatus(
    await call(app(), "/login", { method: "POST", headers: cross }),
    403,
  );
  assertStatus(await call(app(), "/login", { method: "POST" }), 200);
});

Deno.test("csrf: false on the router turns the check off", async () => {
  const off = app({ csrf: false });
  assertStatus(
    await call(off, "/transfer", {
      method: "POST",
      headers: { ...SESSION, "sec-fetch-site": "cross-site" },
    }),
    200,
  );
});

Deno.test("double-submit tokens: header or form field must equal the cookie", async () => {
  const guarded = app({ csrf: { token: true } });
  const minted = await call(guarded, "/token", { headers: SESSION });
  const token = minted.text;
  assert(/^[A-Za-z0-9_-]{43}$/.test(token), token);
  const setCookie = minted.headers.get("set-cookie")!;
  assertEquals(
    setCookie,
    `__Host-csrf=${token}; Path=/; Secure; HttpOnly; SameSite=Strict`,
  );
  const cookie = `sid=s1; __Host-csrf=${token}`;
  assertStatus(
    await call(guarded, "/transfer", { method: "POST", headers: { cookie } }),
    403,
  );
  assertStatus(
    await call(guarded, "/transfer", {
      method: "POST",
      headers: { cookie, "x-csrf-token": "x".repeat(43) },
    }),
    403,
  );
  assertStatus(
    await call(guarded, "/transfer", {
      method: "POST",
      headers: { cookie, "x-csrf-token": token },
    }),
    200,
  );
  const form = await call(guarded, "/form", {
    body: `amount=5&_csrf=${token}`,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
  });
  assertEquals(
    form.text,
    "form 5",
    "the token field is removed before a strict schema sees it",
  );
  const again = await call(guarded, "/token", { headers: { cookie } });
  assertEquals(again.text, token, "an existing token is reused");
});

Deno.test("trusted origins are checked at setup", () => {
  assertThrows(
    () =>
      router({
        auth: "none",
        csrf: { trustedOrigins: ["https://a.example.com/path"] },
      }),
    RouterError,
    "scheme://host",
  );
});

// DB-RTR-012

Deno.test("CSRF option names are checked at setup", () => {
  for (
    const csrf of [
      { trustedOrigin: ["https://a.example.com"] },
      { token: { cookies: "__Host-x" } },
      { token: { cookie: "bad name" } },
      { token: { header: "x token" } },
      { token: { field: "" } },
      { token: "yes" },
      { trustedOrigins: "https://a.example.com" },
    ]
  ) {
    assertThrows(
      () => router({ auth: "none", csrf: csrf as never }),
      RouterError,
      "csrf",
    );
  }
});

Deno.test("csrfToken(c) mints under the router's own token settings", async () => {
  const named = app({
    csrf: {
      token: { cookie: "__Host-xsrf", header: "x-xsrf", field: "xsrf" },
    },
  });
  const minted = await call(named, "/token", { headers: SESSION });
  const token = minted.text;
  assert(
    minted.headers.get("set-cookie")!.startsWith(`__Host-xsrf=${token};`),
    minted.headers.get("set-cookie")!,
  );
  const cookie = `sid=s1; __Host-xsrf=${token}`;
  assertStatus(
    await call(named, "/transfer", {
      method: "POST",
      headers: { cookie, "x-xsrf": token },
    }),
    200,
  );
  assertStatus(
    await call(named, "/transfer", {
      method: "POST",
      headers: { cookie, "x-csrf-token": token },
    }),
    403,
  );
  const off = app();
  const refused = await call(off, "/token", { headers: SESSION });
  assertStatus(refused, 500);
});

function manual(options: Omit<RouterOptions, "auth"> = {}) {
  const app = router({ auth: cookieScheme, csrf: { token: true }, ...options });
  app.post("/manual", async (c) => c.json(await c.readForm()));
  app.post("/raw", async (c) => c.text(await c.req.text()));
  app.post(
    "/header-only",
    { csrf: { source: "header" } },
    async (c) => c.text(await c.readText()),
  );
  app.get("/token", (c) => c.text(csrfToken(c)));
  return app;
}

Deno.test("a form token counts without a body schema, and the handler still reads the form", async () => {
  const api = manual();
  const token = (await call(api, "/token", { headers: SESSION })).text;
  const cookie = `sid=s1; __Host-csrf=${token}`;
  const form = { cookie, "content-type": "application/x-www-form-urlencoded" };
  const read = await call(api, "/manual", {
    method: "POST",
    body: `note=hi&_csrf=${token}`,
    headers: form,
  });
  assertStatus(read, 200);
  assertEquals(read.json, { note: "hi", _csrf: token });
  assertEquals(
    (await call(api, "/raw", {
      method: "POST",
      body: `note=hi&_csrf=${token}`,
      headers: form,
    })).text,
    `note=hi&_csrf=${token}`,
  );
  assertStatus(
    await call(api, "/manual", {
      method: "POST",
      body: "note=hi&_csrf=wrong",
      headers: form,
    }),
    403,
  );
  assertStatus(
    await call(api, "/manual", {
      method: "POST",
      body: "note=hi",
      headers: form,
    }),
    403,
  );
  const tooBig = manual({ limits: { body: 16 } });
  assertStatus(
    await call(tooBig, "/manual", {
      method: "POST",
      body: `note=${"x".repeat(64)}&_csrf=${token}`,
      headers: form,
    }),
    413,
  );
});

Deno.test('csrf: { source: "header" } takes the token from the header only', async () => {
  const api = manual();
  const token = (await call(api, "/token", { headers: SESSION })).text;
  const cookie = `sid=s1; __Host-csrf=${token}`;
  const body = `note=hi&_csrf=${token}`;
  assertStatus(
    await call(api, "/header-only", {
      method: "POST",
      body,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    }),
    403,
  );
  const answer = await call(api, "/header-only", {
    method: "POST",
    body,
    headers: {
      cookie,
      "x-csrf-token": token,
      "content-type": "application/x-www-form-urlencoded",
    },
  });
  assertEquals([answer.status, answer.text], [200, body]);
});

Deno.test("CSRF route settings that could never apply are registration errors", () => {
  const guarded = () => router({ auth: cookieScheme, csrf: { token: true } });
  assertThrows(
    () => guarded().get("/", { csrf: true }, (c) => c.text("x")),
    RouterError,
    "csrf",
  );
  assertThrows(
    () =>
      guarded().get("/", { csrf: { source: "header" } }, (c) => c.text("x")),
    RouterError,
    "csrf",
  );
  assertThrows(
    () =>
      guarded().post(
        "/",
        { csrf: { source: "body" } as never },
        (c) => c.text("x"),
      ),
    RouterError,
    "csrf",
  );
  assertThrows(
    () =>
      router({ auth: cookieScheme }).post(
        "/",
        { csrf: { source: "header" } },
        (c) => c.text("x"),
      ),
    RouterError,
    "token",
  );
  assertThrows(
    () =>
      router({ auth: cookieScheme, csrf: false }).post(
        "/",
        { csrf: true },
        (c) => c.text("x"),
      ),
    RouterError,
    "csrf",
  );
});
