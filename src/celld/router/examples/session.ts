// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A cookie-session web app with CSRF protection: an HTML login form, an
 * encrypted `__Host-session` cookie, and forms that other sites cannot
 * submit on the user's behalf.
 *
 * The session is the `session` scheme: the principal sealed with AES-GCM
 * in a `HttpOnly; Secure; SameSite=Lax` cookie, keyed from
 * `SESSION_SECRET`. Cookies are ambient credentials, so every POST made
 * with one goes through the router's CSRF check: a `Sec-Fetch-Site` of
 * `cross-site` or `same-site`, or an `Origin` that is not this one, is a
 * 403. The router is also set to double-submit tokens: each form carries
 * the `__Host-csrf` cookie's value as `_csrf`, and a POST without it is a
 * 403 too. The login form is public but marked `csrf: true`, so another
 * site cannot log a visitor into an attacker's account either.
 *
 * - `GET /login`: the form (the token is also in `X-CSRF-Token`, for
 *   scripts).
 * - `POST /login`: `user`, `password`, `_csrf`; 303 to `/` with the cookie.
 * - `GET /`: the signed-in page, listing the user's notes.
 * - `POST /notes`: `text`, `_csrf`; 303 back.
 * - `POST /logout`: expires the cookie.
 *
 * Passwords are compared as SHA-256 digests from `USERS` with
 * `secretEquals`; a real deployment would use a slow password hash.
 *
 * ```sh
 * buck2 run root//src/celld/router/examples:session-dev
 * # then open http://localhost:9876/login (user ada, password
 * # "correct horse battery staple")
 * ```
 *
 * @module
 */

import {
  csrfToken,
  hashApiKey,
  router,
  secretEquals,
  session,
  type SessionScheme,
} from "@celld/router";
import { v } from "@celld/sieve";

interface Env {
  readonly SESSION_SECRET: string;
  /** `{"<user>": "<sha256 of password, hex>"}` */
  readonly USERS: string;
  readonly NOTES: KVNamespace;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${
    escape(title)
  }</title></head><body>${body}</body></html>`;
}

function build(env: Env) {
  const sessions: SessionScheme = session({
    keys: [{ id: "k1", secret: env.SESSION_SECRET }],
    maxAge: "PT8H",
  });
  const users: Record<string, string> = JSON.parse(env.USERS);
  const app = router<Env>({ auth: sessions, csrf: { token: true } });

  app.get("/login", { public: true }, (c) => {
    const token = csrfToken(c);
    c.header("x-csrf-token", token);
    return c.html(page(
      "Sign in",
      `<form method="post" action="/login">
        <input type="hidden" name="_csrf" value="${token}">
        <input name="user"> <input name="password" type="password">
        <button>Sign in</button></form>`,
    ));
  });

  app.post("/login", {
    public: true,
    csrf: true,
    bodyType: "form",
    body: v.object({
      user: v.string().min(1).max(64),
      password: v.string().max(256),
    }),
  }, async (c) => {
    const expected = users[c.body.user] ?? "0".repeat(64);
    const ok = await secretEquals(await hashApiKey(c.body.password), expected);
    if (!ok || !(c.body.user in users)) {
      return c.json({
        error: "invalid_credentials",
        message: "wrong user or password",
      }, 401);
    }
    await sessions.issue(c, { subject: c.body.user, scopes: ["notes"] });
    return c.redirect("/", 303);
  });

  app.get("/", async (c) => {
    const notes =
      await c.env.NOTES.get<string[]>(`notes:${c.principal.subject}`, "json") ??
        [];
    const token = csrfToken(c);
    return c.html(page(
      "Notes",
      `<p>Signed in as ${escape(c.principal.subject)}</p><ul>${
        notes.map((note) => `<li>${escape(note)}</li>`).join("")
      }</ul><form method="post" action="/notes"><input type="hidden" name="_csrf" value="${token}"><input name="text"><button>Add</button></form>`,
    ));
  });

  app.post("/notes", {
    scopes: ["notes"],
    bodyType: "form",
    body: v.object({ text: v.string().trim().min(1).max(500) }),
  }, async (c) => {
    const key = `notes:${c.principal.subject}`;
    const notes = await c.env.NOTES.get<string[]>(key, "json") ?? [];
    await c.env.NOTES.put(key, JSON.stringify([...notes, c.body.text]));
    return c.redirect("/", 303);
  });

  app.post("/logout", (c) => {
    sessions.clear(c);
    return c.redirect("/login", 303);
  });

  return app;
}

let app: ReturnType<typeof build> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    app ??= build(env);
    return app.fetch(request, env, ctx);
  },
};
