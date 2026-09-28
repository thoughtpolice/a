// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A sign-in route that password guessing cannot outrun: a per-address limit
 * before the password check, and a per-account limit on failures.
 *
 * - **Per address**, before anything else runs: 10 attempts a minute, 3 at
 *   once (`before: [rateLimit(...)]`, keyed by `byIp()`). A flood from one
 *   address, or one IPv6 /64, gets 429s without ever reaching the costly
 *   password derivation, and each answer carries the `RateLimit` fields.
 * - **Per account**, on failures only: 3 wrong passwords in 15 minutes lock
 *   the account's sign-in until a unit comes back (5 minutes). Every
 *   attempt is charged up front and refunded when it succeeds, so parallel
 *   guesses are capped too, and a user who signs in keeps their budget.
 *   The key is the lower-cased user name whether or not the user exists,
 *   so the limit does not tell which accounts exist. It does let anyone
 *   hold an account's sign-in off for minutes, the usual price of
 *   per-account limits; the per-address limit slows that down.
 *
 * Both limits are `durableLimiter`s over the `RateLimitShard` objects this
 * Worker exports, so every Worker of a fleet shares them, and they survive a
 * restart (the spec restarts `celld dev` to show it). The limiter keys are
 * stored hashed under `RATE_LIMIT_SECRET`, so storage never holds a user
 * name or an address.
 *
 * - `POST /login` (public): `{user, password}`; 200 with an encrypted
 *   `__Host-session` cookie, 401 for a wrong user or password, 429 when a
 *   limit refuses.
 * - `GET /me`: who the session is.
 *
 * `USERS` holds salted PBKDF2 hashes, as in the router's `session`
 * example: `pbkdf2-sha256$<iterations>$<salt>$<hash>`, at least 600,000
 * iterations. An unknown user costs the same derivation against a fixed
 * dummy. `USERS`, `SESSION_SECRET` and `RATE_LIMIT_SECRET` are secrets; the
 * spec's `vars` set public example values for `celld dev`. Without the
 * secrets every request is an opaque 500.
 *
 * The address is `CF-Connecting-IP`, which is trustworthy only on
 * Cloudflare's edge. Anywhere a client reaches the Worker directly (and
 * under `celld dev`) a client writes it, and could rotate it for fresh
 * per-address budgets; the per-account limit still holds then. Name the
 * platform's peer (`clientIp.peer`) when deployed elsewhere.
 *
 * ```sh
 * buck2 run root//src/celld/sec/ratelimit/examples:login-dev
 * curl -sS -i localhost:9876/login -H 'content-type: application/json' \
 *   -d '{"user":"ada","password":"guess"}'
 * ```
 *
 * @module
 */

import {
  durableLimiter,
  type RateLimiter,
  type RateLimitShardApi,
  retryAfterField,
} from "@celld/sec/ratelimit";
import { byIp, rateLimit } from "@celld/sec/ratelimit/router";
import {
  HttpError,
  router,
  secretEquals,
  session,
  type SessionScheme,
} from "@celld/web/router";
import { v } from "@celld/sieve";

export { RateLimitShard } from "@celld/sec/ratelimit/durable";

interface Env {
  readonly RATE_LIMITS: DurableObjectNamespace<RateLimitShardApi>;
  readonly SESSION_SECRET?: string;
  readonly RATE_LIMIT_SECRET?: string;
  /** `{"<user>": "pbkdf2-sha256$<iterations>$<salt>$<hash>"}` */
  readonly USERS?: string;
}

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

function parsePasswordHash(text: unknown): PasswordHash | null {
  const match = typeof text === "string" ? PASSWORD_HASH.exec(text) : null;
  if (match === null) return null;
  const iterations = Number(match[1]);
  if (iterations < 600_000 || iterations > 5_000_000) return null;
  return { iterations, salt: fromBase64Url(match[2]), hash: match[3] };
}

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

function build(
  env: Env & { SESSION_SECRET: string; RATE_LIMIT_SECRET: string },
) {
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
    else users.set(user.toLowerCase(), parsed);
  }

  const perAddress: RateLimiter = durableLimiter(env.RATE_LIMITS, {
    name: "login-address",
    policies: [{ name: "address", limit: 10, window: "PT1M", burst: 3 }],
    secret: env.RATE_LIMIT_SECRET,
  });
  const failures: RateLimiter = durableLimiter(env.RATE_LIMITS, {
    name: "login-failures",
    policies: [{ name: "failures", limit: 3, window: "PT15M" }],
    secret: env.RATE_LIMIT_SECRET,
  });

  const app = router<Env>({ auth: sessions });

  app.post("/login", {
    // Anyone may try to sign in; the limits below are what bound it.
    public: true,
    csrf: true,
    before: [rateLimit({ limiter: perAddress, key: byIp() })],
    limits: { body: 4096 },
    body: v.object({
      user: v.string().min(1).max(64),
      password: v.string().max(256),
    }),
  }, async (c) => {
    const user = c.body.user.toLowerCase();
    const account = `user:${user}`;
    const charged = await failures.limit(account);
    if (!charged.allowed) {
      throw new HttpError(429, "too many failed sign-ins for this account", {
        code: "rate_limited",
        headers: { "retry-after": retryAfterField(charged.retryAfterMs) },
      });
    }
    const stored = users.get(user);
    const derived = await derive(c.body.password, stored ?? DUMMY);
    const ok = await secretEquals(derived, (stored ?? DUMMY).hash);
    if (!ok || stored === undefined) {
      return c.json({
        error: "invalid_credentials",
        message: "wrong user or password",
      }, 401);
    }
    await failures.refund(account);
    await sessions.issue(c, { subject: user });
    return c.json({ user });
  });

  app.get("/me", (c) => c.json({ user: c.principal.subject }));

  return app;
}

let app: ReturnType<typeof build> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { SESSION_SECRET, RATE_LIMIT_SECRET } = env;
    if (
      SESSION_SECRET === undefined || SESSION_SECRET === "" ||
      RATE_LIMIT_SECRET === undefined || RATE_LIMIT_SECRET === ""
    ) {
      console.error("SESSION_SECRET and RATE_LIMIT_SECRET must be set");
      return Promise.resolve(
        Response.json({ error: "internal_error" }, {
          status: 500,
          headers: { "cache-control": "no-store" },
        }),
      );
    }
    app ??= build({ ...env, SESSION_SECRET, RATE_LIMIT_SECRET });
    return app.fetch(request, env, ctx);
  },
};
