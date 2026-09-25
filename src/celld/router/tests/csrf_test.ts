// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import {
  type AuthScheme,
  bearer,
  csrfToken,
  router,
  RouterError,
  type RouterOptions,
} from "@celld/router";
import { v } from "@celld/sieve";
import { assertMatch, assertStatus, call } from "./fixture.ts";

const cookieScheme: AuthScheme = {
  name: "cookie",
  ambient: true,
  authenticate: (c) => c.cookie("sid") === "s1" ? { subject: "ada" } : null,
};

function app(options: Partial<RouterOptions> = {}) {
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
  app.post("/login", { public: true, csrf: true }, (c) => c.text("login"));
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
