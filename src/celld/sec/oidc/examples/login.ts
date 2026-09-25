// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A relying party web app: "Sign in with" an OpenID Provider, with the
 * login's round trip in a sealed cookie and the signed-in user in
 * another.
 *
 * - `GET /login?next=/me`: `LoginFlow.start`: a 303 to the provider (the
 *   request pushed with PAR: PKCE, `state`, `nonce`), with the pending
 *   login sealed in the `oidc-login` cookie.
 * - `GET /callback`: `LoginFlow.finish`: the cookie must be this
 *   browser's, the response's `iss` and `state` must match, the code is
 *   redeemed and the ID token validated (signature, `iss`, `aud`,
 *   `nonce`, `at_hash`); then the sealed `app_session` cookie and a 303
 *   to `next`. A failure is a 400 naming the step that failed (the
 *   `error` code only; the details go to the log).
 * - `GET /me`: the session's UserInfo, refused when UserInfo answers
 *   about another `sub` than the ID token's.
 * - `GET /logout`: a confirmation page only, with a form (and a CSRF
 *   token) that posts to `POST /logout`. A GET never signs anyone out,
 *   so a link or an image on another site cannot.
 * - `POST /logout` (`_csrf`): checked by the router's CSRF policy
 *   (`Origin`/`Sec-Fetch-Site` and the double-submit token), clears the
 *   session, and only then sends the browser to the provider's
 *   `end_session_endpoint` with the ID token as hint.
 *
 * The provider is `OIDC_ISSUER`, discovered from its OpenID
 * configuration; the client id is `OIDC_CLIENT_ID`, a public client whose
 * redirect URI is `/callback` on `APP_ORIGIN`, which a deployment sets.
 * Without it (development only) the app's origin is the request's, and
 * only when its host is a loopback IP literal, so a `Host` header cannot
 * pick the redirect URI. `COOKIE_SECRET` seals both cookies. They are
 * `Secure` over https; the example runs on plain http, so here they are
 * not.
 *
 * ```sh
 * buck2 run root//src/celld/sec/oidc/examples:login-dev
 * # then open http://127.0.0.1:9876/login?next=/me
 * ```
 *
 * @module
 */

import { OAuthError } from "@celld/sec/oauth";
import type { AuthorizedGrant } from "@celld/sec/oauth/client";
import { IdTokenError } from "@celld/sec/oidc";
import {
  clearCookie,
  CookieSealer,
  isLocalPath,
  LoginFlow,
  OidcClient,
  readCookie,
  setCookie,
} from "@celld/sec/oidc/rp";
import { csrfToken, router } from "@celld/web/router";

interface Env {
  readonly OIDC_ISSUER: string;
  readonly OIDC_CLIENT_ID: string;
  readonly COOKIE_SECRET: string;
  /** This app's origin, such as `https://app.example.com`; a deployment sets it. */
  readonly APP_ORIGIN?: string;
  /** `"true"` only for a provider on http://127.0.0.1 during development. */
  readonly OIDC_LOOPBACK_FOR_DEVELOPMENT?: string;
}

interface Session {
  readonly subject: string;
  readonly tokens: AuthorizedGrant;
}

const SESSION_SEC = 3600;

interface Parts {
  readonly client: OidcClient;
  readonly flow: LoginFlow;
  readonly sealer: CookieSealer;
  readonly secure: boolean;
  readonly sessionCookie: string;
}

/** The one set of parts, for the one app origin; never one per `Host`. */
let cache: { readonly origin: string; readonly parts: Promise<Parts> } | null =
  null;

function isLoopbackLiteral(hostname: string): boolean {
  return hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * This app's origin: `APP_ORIGIN` when set. Otherwise, for development,
 * the request's origin when its host is a loopback IP literal, and null
 * for any other host (which is refused).
 */
function appOrigin(url: URL, env: Env): string | null {
  if (env.APP_ORIGIN !== undefined && env.APP_ORIGIN !== "") {
    const origin = new URL(env.APP_ORIGIN).origin;
    return url.origin === origin ? origin : null;
  }
  return isLoopbackLiteral(url.hostname) ? url.origin : null;
}

function parts(url: URL, env: Env): Promise<Parts> {
  const origin = appOrigin(url, env);
  // The fetch handler refuses such a request before it gets here.
  if (origin === null) throw new Error("not this app's host");
  if (cache === null || cache.origin !== origin) {
    const found = (async () => {
      const secure = origin.startsWith("https:");
      const sealer = await CookieSealer.create({ secret: env.COOKIE_SECRET });
      const client = new OidcClient({
        issuer: env.OIDC_ISSUER,
        client: { method: "none", clientId: env.OIDC_CLIENT_ID },
        redirectUri: `${origin}/callback`,
        allowLoopbackForDevelopment:
          env.OIDC_LOOPBACK_FOR_DEVELOPMENT === "true",
      });
      return {
        client,
        sealer,
        secure,
        sessionCookie: secure ? "__Host-app_session" : "app_session",
        flow: new LoginFlow({ client, sealer, secure }),
      };
    })();
    cache = { origin, parts: found };
  }
  return cache.parts;
}

async function session(request: Request, p: Parts): Promise<Session | null> {
  const stored = await p.sealer.unseal<Session>(
    p.sessionCookie,
    readCookie(request.headers.get("cookie"), p.sessionCookie),
  );
  return stored === null
    ? null
    : { ...stored, tokens: await p.client.unsafeRestoreGrant(stored.tokens) };
}

/**
 * The error code for the browser. The message (which can carry the
 * provider's own error description) is logged, never sent back.
 */
function failure(error: unknown): { error: string } {
  if (error instanceof OAuthError) {
    console.warn("login failed:", error.message);
    return { error: error.error ?? error.kind };
  }
  if (error instanceof IdTokenError) {
    console.warn("login failed:", error.message);
    return { error: `id_token_${error.code}` };
  }
  throw error;
}

// Deliberately unauthenticated: these are the sign-in pages themselves.
// Who is signed in is the sealed `app_session` cookie, checked by `/me`
// and `POST /logout`.
const app = router<Env>({ auth: "none", csrf: { token: true } });

app.get("/login", async (c) => {
  const next = c.url.searchParams.get("next") ?? "/me";
  if (!isLocalPath(next)) return c.fail(400, "next must be a local path");
  const p = await parts(c.url, c.env);
  return await p.flow.start(c.req, {
    scope: ["profile", "email"],
    returnTo: next,
  });
});

app.get("/callback", async (c) => {
  const p = await parts(c.url, c.env);
  try {
    const { login, returnTo, clearCookie: cleared } = await p.flow.finish(
      c.req,
    );
    const value: Session = {
      subject: login.subject,
      tokens: login.tokens,
    };
    const sealed = await p.sealer.seal(p.sessionCookie, value, SESSION_SEC);
    const headers = new Headers({ location: returnTo ?? "/me" });
    headers.append("set-cookie", cleared);
    headers.append(
      "set-cookie",
      setCookie(p.sessionCookie, sealed, {
        maxAgeSec: SESSION_SEC,
        secure: p.secure,
      }),
    );
    return new Response(null, { status: 303, headers });
  } catch (error) {
    const cleared = await p.flow.clearPendingCookie(c.req);
    if (cleared !== null) c.header("set-cookie", cleared);
    return c.json(failure(error), { status: 400 });
  }
});

app.get("/me", async (c) => {
  const p = await parts(c.url, c.env);
  const current = await session(c.req, p);
  if (current === null) {
    return c.json({ error: "not signed in" }, { status: 401 });
  }
  try {
    const claims = await p.client.userinfo(current.tokens, current.subject);
    return c.json({ subject: current.subject, claims });
  } catch (error) {
    return c.json(failure(error), { status: 502 });
  }
});

app.get("/logout", (c) =>
  c.html(
    `<!doctype html><title>Sign out</title><form method="post" action="/logout"><input type="hidden" name="_csrf" value="${
      csrfToken(c)
    }"><button>Sign out</button></form>`,
  ));

app.post("/logout", {
  csrf: true,
  bodyType: "form",
  limits: { body: 256, jsonKeys: 2 },
}, async (c) => {
  const p = await parts(c.url, c.env);
  const current = await session(c.req, p);
  const target = current === null
    ? "/me"
    : await p.client.logoutUrl({ idTokenHint: current.tokens });
  return new Response(null, {
    status: 303,
    headers: {
      location: target,
      "set-cookie": clearCookie(p.sessionCookie, { secure: p.secure }),
    },
  });
});

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (appOrigin(new URL(request.url), env) === null) {
      return new Response("not this app's host", { status: 421 });
    }
    return await app.fetch(request, env, ctx);
  },
};
