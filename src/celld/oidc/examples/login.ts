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
 *   to `next`. A failure is a 400 naming the step that failed.
 * - `GET /me`: the session's UserInfo, refused when UserInfo answers
 *   about another `sub` than the ID token's.
 * - `GET /logout`: clears the session and sends the browser to the
 *   provider's `end_session_endpoint` with the ID token as hint.
 *
 * The provider is `OIDC_ISSUER`, discovered from its OpenID
 * configuration; the client id is `OIDC_CLIENT_ID`, a public client whose
 * redirect URI is this origin's `/callback`. `COOKIE_SECRET` seals both
 * cookies. They are `Secure` over https; the example runs on plain http,
 * so here they are not.
 *
 * ```sh
 * buck2 run root//src/celld/oidc/examples:login-dev
 * # then open http://127.0.0.1:9876/login?next=/me
 * ```
 *
 * @module
 */

import { OAuthError } from "@celld/oauth";
import type { TokenSet } from "@celld/oauth/client";
import { IdTokenError } from "@celld/oidc";
import {
  clearCookie,
  CookieSealer,
  isLocalPath,
  LoginFlow,
  OidcClient,
  readCookie,
  setCookie,
} from "@celld/oidc/rp";
import { router } from "@celld/router";

interface Env {
  readonly OIDC_ISSUER: string;
  readonly OIDC_CLIENT_ID: string;
  readonly COOKIE_SECRET: string;
}

interface Session {
  readonly subject: string;
  readonly idToken: string;
  readonly tokens: TokenSet;
}

const SESSION = "app_session";
const SESSION_SEC = 3600;

interface Parts {
  readonly client: OidcClient;
  readonly flow: LoginFlow;
  readonly sealer: CookieSealer;
  readonly secure: boolean;
}

const cache = new Map<string, Promise<Parts>>();

function parts(url: URL, env: Env): Promise<Parts> {
  let found = cache.get(url.origin);
  if (found === undefined) {
    found = (async () => {
      const secure = url.protocol === "https:";
      const sealer = await CookieSealer.create({ secret: env.COOKIE_SECRET });
      const client = new OidcClient({
        issuer: env.OIDC_ISSUER,
        client: { method: "none", clientId: env.OIDC_CLIENT_ID },
        redirectUri: `${url.origin}/callback`,
      });
      return {
        client,
        sealer,
        secure,
        flow: new LoginFlow({ client, sealer, secure }),
      };
    })();
    cache.set(url.origin, found);
  }
  return found;
}

async function session(request: Request, p: Parts): Promise<Session | null> {
  return await p.sealer.unseal<Session>(
    SESSION,
    readCookie(request.headers.get("cookie"), SESSION),
  );
}

function failure(error: unknown): { error: string; message: string } {
  if (error instanceof OAuthError) {
    return { error: error.error ?? error.kind, message: error.message };
  }
  if (error instanceof IdTokenError) {
    return { error: `id_token_${error.code}`, message: error.message };
  }
  throw error;
}

const app = router<Env>({ auth: "none" });

app.get("/login", async (c) => {
  const next = c.url.searchParams.get("next") ?? "/me";
  if (!isLocalPath(next)) return c.fail(400, "next must be a local path");
  const p = await parts(c.url, c.env);
  return await p.flow.start({ scope: ["profile", "email"], returnTo: next });
});

app.get("/callback", async (c) => {
  const p = await parts(c.url, c.env);
  try {
    const { login, returnTo, clearCookie: cleared } = await p.flow.finish(
      c.req,
    );
    const value: Session = {
      subject: login.subject,
      idToken: login.idToken,
      tokens: login.tokens,
    };
    const sealed = await p.sealer.seal(SESSION, value, SESSION_SEC);
    const headers = new Headers({ location: returnTo ?? "/me" });
    headers.append("set-cookie", cleared);
    headers.append(
      "set-cookie",
      setCookie(SESSION, sealed, { maxAgeSec: SESSION_SEC, secure: p.secure }),
    );
    return new Response(null, { status: 303, headers });
  } catch (error) {
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

app.get("/logout", async (c) => {
  const p = await parts(c.url, c.env);
  const current = await session(c.req, p);
  const target = current === null
    ? "/me"
    : await p.client.logoutUrl({ idTokenHint: current.idToken });
  return new Response(null, {
    status: 303,
    headers: {
      location: target,
      "set-cookie": clearCookie(SESSION, { secure: p.secure }),
    },
  });
});

export default { fetch: app.fetch };
