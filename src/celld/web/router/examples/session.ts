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
 * - `GET /?cursor=`: the signed-in page, listing the user's notes, 50 at
 *   a time.
 * - `POST /notes`: `text`, `_csrf`; 303 back.
 * - `POST /logout`: expires the cookie in this browser.
 *
 * `USERS` holds a salted, slow hash of each password:
 * `pbkdf2-sha256$<iterations>$<salt>$<hash>` (PBKDF2-HMAC-SHA256, at least
 * 600,000 iterations, a random salt of at least 16 bytes per user, salt
 * and 32-byte hash in base64url). A login derives the same hash and
 * compares it with `secretEquals`; an unknown user costs the same
 * derivation, against a fixed dummy, so timing does not say which users
 * exist. (`hashApiKey`'s plain SHA-256 is only for long random keys: a
 * leaked table of fast, unsalted password hashes is cracked offline.) A
 * malformed entry, or one under 600,000 iterations, lets nobody in as that
 * user. Login attempts are not limited here, and the router does not do
 * it: a deployment rate-limits `POST /login`. `USERS` and `SESSION_SECRET`
 * are secrets: the spec's `vars` set public example values for `celld
 * dev`. Without `USERS` nobody can log in; without `SESSION_SECRET` every
 * request is an opaque 500.
 *
 * Logout only clears the browser's copy. The cookie is the whole session,
 * so a copy taken before logout stays valid until its `maxAge` (8 hours)
 * runs out; revoking one needs server-side state, which this example does
 * not keep.
 *
 * Notes are stored under a domain-separated HMAC of the principal's `key`, not its
 * `subject` (see the router README), each note its own KV entry, so two
 * concurrent posts cannot overwrite each other.
 *
 * ```sh
 * buck2 run root//src/celld/web/router/examples:session-dev
 * # then open http://127.0.0.1:9876/login (user ada, password
 * # "correct horse battery staple")
 * ```
 *
 * @module
 */

import { opaqueIdentity } from "@celld/core/bounds";
import {
  csrfToken,
  router,
  secretEquals,
  session,
  type SessionScheme,
} from "@celld/web/router";
import { v } from "@celld/sieve";

interface Env {
  readonly SESSION_SECRET?: string;
  /** `{"<user>": "pbkdf2-sha256$<iterations>$<salt>$<hash>"}` */
  readonly USERS?: string;
  readonly NOTES: KVNamespace;
}

const PAGE = 50;

/** A stored password hash, parsed. */
interface PasswordHash {
  readonly iterations: number;
  readonly salt: Uint8Array<ArrayBuffer>;
  readonly hash: string;
}

const PASSWORD_HASH =
  /^pbkdf2-sha256\$(\d{6,7})\$([A-Za-z0-9_-]{22,86})\$([A-Za-z0-9_-]{43})$/;

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-")
    .replace(/\//g, "_").replace(/=+$/, "");
}

/** `text` as a {@link PasswordHash}, or null when it is not a usable one. */
function parsePasswordHash(text: unknown): PasswordHash | null {
  const match = typeof text === "string" ? PASSWORD_HASH.exec(text) : null;
  if (match === null) return null;
  const iterations = Number(match[1]);
  if (iterations < 600_000 || iterations > 5_000_000) return null;
  return { iterations, salt: fromBase64Url(match[2]), hash: match[3] };
}

/** PBKDF2-HMAC-SHA256 of `password`, 32 bytes, as base64url. */
async function derive(password: string, stored: PasswordHash): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: stored.salt,
      iterations: stored.iterations,
    },
    key,
    256,
  );
  return toBase64Url(new Uint8Array(bits));
}

/** What an unknown user's password is checked against. */
const DUMMY: PasswordHash = parsePasswordHash(
  `pbkdf2-sha256$600000$${"A".repeat(22)}$${"A".repeat(43)}`,
)!;

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${
    escape(title)
  }</title></head><body>${body}</body></html>`;
}

/**
 * Where the owner's notes live: the keyed identity of `principal.key`, which
 * names the scheme, issuer and subject together (so the same subject from
 * another scheme is another owner) without exposing the raw identity.
 */
async function notesPrefix(
  principal: { readonly key: string },
  secret: string,
) {
  return `notes:${await opaqueIdentity(
    new TextEncoder().encode(secret),
    "router.session.notes",
    principal.key,
  )}:`;
}

function build(env: Env & { readonly SESSION_SECRET: string }) {
  const sessions: SessionScheme = session({
    keys: [{ id: "k1", secret: env.SESSION_SECRET }],
    maxAge: "PT8H",
  });
  // A Map, so a user named `constructor` or `__proto__` is just unknown.
  const users = new Map<string, PasswordHash>();
  for (
    const [user, text] of Object.entries(
      env.USERS === undefined ? {} : JSON.parse(env.USERS),
    )
  ) {
    const parsed = parsePasswordHash(text);
    if (parsed === null) console.error(`USERS: unusable hash for ${user}`);
    else users.set(user, parsed);
  }
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
    const stored = users.get(c.body.user);
    const derived = await derive(c.body.password, stored ?? DUMMY);
    const ok = await secretEquals(derived, (stored ?? DUMMY).hash);
    if (!ok || stored === undefined) {
      return c.json({
        error: "invalid_credentials",
        message: "wrong user or password",
      }, 401);
    }
    await sessions.issue(c, { subject: c.body.user, scopes: ["notes"] });
    return c.redirect("/", 303);
  });

  app.get("/", {
    query: v.object({ cursor: v.string().max(1024).optional() }),
  }, async (c) => {
    const listed = await c.env.NOTES.list({
      prefix: await notesPrefix(c.principal, env.SESSION_SECRET),
      limit: PAGE,
      cursor: c.query.cursor,
    });
    const notes = await Promise.all(
      listed.keys.map((entry) => c.env.NOTES.get(entry.name)),
    );
    const more = listed.list_complete
      ? ""
      : `<p><a href="/?cursor=${
        escape(encodeURIComponent(listed.cursor))
      }">More</a></p>`;
    const token = csrfToken(c);
    return c.html(page(
      "Notes",
      `<p>Signed in as ${escape(c.principal.subject)}</p><ul>${
        notes.filter((note) => note !== null)
          .map((note) => `<li>${escape(note)}</li>`).join("")
      }</ul>${more}<form method="post" action="/notes"><input type="hidden" name="_csrf" value="${token}"><input name="text"><button>Add</button></form>`,
    ));
  });

  app.post("/notes", {
    scopes: ["notes"],
    bodyType: "form",
    body: v.object({ text: v.string().trim().min(1).max(500) }),
  }, async (c) => {
    // One entry per note, named by the request's ULID, so notes list in
    // the order they were posted.
    await c.env.NOTES.put(
      `${await notesPrefix(c.principal, env.SESSION_SECRET)}${c.requestId}`,
      c.body.text,
    );
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
    const secret = env.SESSION_SECRET;
    if (secret === undefined || secret === "") {
      console.error("SESSION_SECRET is not set");
      return Promise.resolve(
        Response.json({ error: "internal_error" }, {
          status: 500,
          headers: { "cache-control": "no-store" },
        }),
      );
    }
    app ??= build({ ...env, SESSION_SECRET: secret });
    return app.fetch(request, env, ctx);
  },
};
