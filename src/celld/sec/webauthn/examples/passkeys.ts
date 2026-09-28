// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Accounts with passkeys only: sign up, sign in (also from autofill), add a
 * second passkey, rename and delete them, with sessions from
 * `@celld/web/router` and the credentials in a `PasskeyDirectory` Durable
 * Object.
 *
 * - `GET /`: a page to try it in a browser; `GET /client.js`, its script,
 *   built from `@celld/sec/webauthn/browser` (the router's page CSP allows only
 *   same-origin scripts, and there is no inline script).
 * - `/passkeys/...`: `passkeyRoutes` (see its documentation): sign-up and
 *   sign-in are public, limited per address by a `durableLimiter` to 60
 *   requests a minute, 30 at once; adding a passkey needs a session issued
 *   by a passkey ceremony in the last five minutes, and managing them needs
 *   the session.
 * - `GET /me`: who the session is.
 *
 * The relying party is `RP_ID` and `RP_ORIGINS` (comma-separated, exactly as
 * browsers write origins). The spec sets `localhost` and
 * `http://localhost:9876` for `celld dev`, which browsers accept over plain
 * http; open http://localhost:9876 (not 127.0.0.1, which cannot be an RP
 * ID). A deployment sets its own domain. `SESSION_SECRET` (at least 32
 * bytes) keys the sessions and the sealed ceremony cookies; it is a secret,
 * set by the spec's `vars` for `celld dev`. Without these every request is
 * an opaque 500.
 *
 * The address the limiter keys on is `CF-Connecting-IP`, trustworthy only
 * on Cloudflare's edge (see `@celld/sec/ratelimit`'s `login` example).
 *
 * ```sh
 * buck2 run root//src/celld/sec/webauthn/examples:passkeys-dev
 * # then open http://localhost:9876 in a browser with a passkey provider
 * ```
 *
 * @module
 */

import clientScript from "@celld/sec/webauthn/examples/client";
import { durableLimiter, type RateLimitShardApi } from "@celld/sec/ratelimit";
import { router, session } from "@celld/web/router";
import {
  durablePasskeys,
  type PasskeyDirectoryApi,
  RelyingParty,
} from "@celld/sec/webauthn";
import { passkeyRoutes } from "@celld/sec/webauthn/router";

export { RateLimitShard } from "@celld/sec/ratelimit/durable";
export { PasskeyDirectory } from "@celld/sec/webauthn/durable";

interface Env {
  readonly PASSKEYS: DurableObjectNamespace<PasskeyDirectoryApi>;
  readonly RATE_LIMITS: DurableObjectNamespace<RateLimitShardApi>;
  readonly RP_ID?: string;
  readonly RP_ORIGINS?: string;
  readonly SESSION_SECRET?: string;
}

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Passkeys</title>
<script type="module" src="/client.js"></script></head>
<body>
<h1>Passkeys on celld</h1>
<p><label>Name <input id="name" autocomplete="username webauthn"></label>
<button id="signup">Sign up</button> <button id="signin">Sign in</button></p>
<p><button id="add">Add a passkey</button> <button id="list">My passkeys</button>
<button id="me">Who am I?</button></p>
<pre id="out"></pre>
</body>
</html>
`;

function build(env: Required<Omit<Env, "PASSKEYS" | "RATE_LIMITS">> & Env) {
  const secret = env.SESSION_SECRET;
  const sessions = session({ keys: [{ id: "k1", secret }] });
  const rp = new RelyingParty({
    id: env.RP_ID,
    origins: env.RP_ORIGINS.split(",").map((origin) => origin.trim()),
  });
  const app = router<Env>({ auth: sessions });
  app.get("/", { public: true }, (c) => c.html(PAGE));
  app.get(
    "/client.js",
    { public: true },
    () =>
      new Response(clientScript, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }),
  );
  app.mount(
    "/passkeys",
    passkeyRoutes({
      rp,
      store: (env) => durablePasskeys(env.PASSKEYS, { rpId: rp.id }),
      sessions,
      ceremonyScope: "accounts",
      keys: [{ id: "k1", secret }],
      signUp: true,
      limiter: durableLimiter(env.RATE_LIMITS, {
        name: "passkeys-address",
        policies: [{ name: "passkeys", limit: 60, window: "PT1M", burst: 30 }],
        secret,
      }),
      principal: (user) => ({
        ...user.principal,
        claims: { passkeyAuthenticatedAt: Date.now() },
      }),
      authorizeRegistration: (principal) => {
        const at = principal.claims.passkeyAuthenticatedAt;
        const age = typeof at === "number" ? Date.now() - at : Infinity;
        return age >= 0 && age <= rp.timeoutMs;
      },
    }),
  );
  app.get("/me", (c) => c.json({ subject: c.principal.subject }));
  return app;
}

let app: ReturnType<typeof build> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { RP_ID, RP_ORIGINS, SESSION_SECRET } = env;
    if (
      !RP_ID || !RP_ORIGINS || !SESSION_SECRET || SESSION_SECRET.length < 32
    ) {
      console.error(
        "RP_ID, RP_ORIGINS and SESSION_SECRET (32 bytes) must be set",
      );
      return Promise.resolve(
        Response.json({ error: "internal_error" }, {
          status: 500,
          headers: { "cache-control": "no-store" },
        }),
      );
    }
    app ??= build({ ...env, RP_ID, RP_ORIGINS, SESSION_SECRET });
    return app.fetch(request, env, ctx);
  },
};
