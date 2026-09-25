// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An OpenID Provider Worker: `OpenIdProvider` with its records (codes,
 * refresh token families, login sessions, pushed requests) in the
 * `OAuthRecords` Durable Object, and the host's part (a login page and a
 * session cookie) around it.
 *
 * - `GET /.well-known/openid-configuration`, `/authorize`, `/par`,
 *   `/token`, `/jwks`, `/userinfo`, `/end_session`, `/revoke`,
 *   `/introspect`: the provider's endpoints, issuer = this origin.
 * - `GET /login?i=<interaction>`: the login page the interaction hook
 *   sends browsers to; `POST /login` (`i`, `user`, `password`) signs the
 *   user in (the sealed `op_session` cookie) and resumes the
 *   authorization with `authTime` and a login session id, whose hash is
 *   the ID token's `sid`.
 *
 * The interaction hook grants at once to a browser with a session, unless
 * `prompt=login` or `max_age` says it must log in again; with
 * `prompt=none` it answers `login_required` instead of showing the page.
 * Logout (`/end_session` with the ID token as hint) ends the login
 * session: its access tokens get no more UserInfo, its refresh tokens no
 * more tokens, and the cookie is cleared. The one client, `web`, is
 * public, redirects to `http://127.0.0.1/cb` (any port, RFC 8252) and
 * comes back after logout to `http://127.0.0.1:8765/bye`.
 *
 * The signing key is `SIGNING_JWK`, a private JWK (JSON) kept as a secret,
 * so tokens outlive restarts. The login page is a stub: a real one checks a
 * password hash, binds the form to the browser that started the
 * interaction (CSRF), and would never take a password over plain http.
 *
 * ```sh
 * buck2 run root//src/celld/oidc/examples:provider-dev
 * curl -sS localhost:9876/.well-known/openid-configuration
 * ```
 *
 * @module
 */

import { durableRecordStore, type RecordStoreApi } from "@celld/oauth/durable";
import { type SigningKey, signingKeyFromJwk } from "@celld/oauth/server";
import { OpenIdProvider } from "@celld/oidc/provider";
import {
  clearCookie,
  CookieSealer,
  readCookie,
  setCookie,
} from "@celld/oidc/rp";
import { router } from "@celld/router";

export { OAuthRecords } from "@celld/oauth/durable";

interface Env {
  readonly OAUTH_RECORDS: DurableObjectNamespace<RecordStoreApi>;
  /** The ES256 private JWK (with `kid`) that signs tokens, as base64url JSON. */
  readonly SIGNING_JWK: string;
  /** At least 32 bytes; seals the `op_session` cookie. */
  readonly COOKIE_SECRET: string;
}

interface Session {
  readonly user: string;
  readonly authTime: number;
  readonly sessionId: string;
}

const USERS: Readonly<Record<string, Record<string, unknown>>> = {
  ada: {
    name: "Ada Lovelace",
    email: "ada@example.com",
    email_verified: true,
    phone_number: "+44 20 7946 0000",
  },
};

const PASSWORDS: Readonly<Record<string, string>> = {
  ada: "correct horse battery staple",
};

const COOKIE = "op_session";
const SESSION_SEC = 8 * 3600;

let key: Promise<SigningKey> | null = null;
let sealer: Promise<CookieSealer> | null = null;
const providers = new Map<string, OpenIdProvider>();

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

async function session(request: Request, env: Env): Promise<Session | null> {
  sealer ??= CookieSealer.create({ secret: env.COOKIE_SECRET });
  return await (await sealer).unseal<Session>(
    COOKIE,
    readCookie(request.headers.get("cookie"), COOKIE),
  );
}

async function provider(origin: string, env: Env): Promise<OpenIdProvider> {
  const known = providers.get(origin);
  if (known !== undefined) return known;
  key ??= signingKeyFromJwk(JSON.parse(env.SIGNING_JWK), "ES256");
  const op = new OpenIdProvider({
    issuer: origin,
    keys: [await key],
    store: durableRecordStore(env.OAUTH_RECORDS),
    clients: [{
      client_id: "web",
      redirect_uris: ["http://127.0.0.1/cb"],
      post_logout_redirect_uris: ["http://127.0.0.1:8765/bye"],
    }],
    interaction: async (context) => {
      const current = await session(context.request, env);
      if (current !== null && !context.needsLogin(current.authTime)) {
        return {
          grant: {
            subject: current.user,
            authTime: current.authTime,
            sessionId: current.sessionId,
            amr: ["pwd"],
          },
        };
      }
      if (context.prompt.includes("none")) {
        return { deny: { error: "login_required" } };
      }
      return new Response(null, {
        status: 303,
        headers: { location: `/login?i=${context.interactionId}` },
      });
    },
    claims: ({ subject, claims }) =>
      Object.fromEntries(
        claims.flatMap((name) =>
          USERS[subject]?.[name] === undefined
            ? []
            : [[name, USERS[subject][name]]]
        ),
      ),
    endSession: () => {},
  });
  providers.set(origin, op);
  return op;
}

const app = router<Env>({ auth: "none" });

app.get("/login", async (c) => {
  const op = await provider(c.url.origin, c.env);
  const id = c.url.searchParams.get("i") ?? "";
  const pending = await op.interaction(id);
  if (pending === null) return c.fail(400, "the sign-in request expired");
  return c.html(
    `<!doctype html><title>Sign in</title><p>Sign in to ${
      escape(pending.client.client_id)
    }</p><form method="post"><input type="hidden" name="i" value="${
      escape(id)
    }"><input name="user"><input name="password" type="password"><button>Sign in</button></form>`,
  );
});

app.post("/login", async (c) => {
  const op = await provider(c.url.origin, c.env);
  const form = await c.readForm();
  const [id, user, password] = ["i", "user", "password"].map((name) =>
    typeof form[name] === "string" ? form[name] as string : ""
  );
  if (PASSWORDS[user] === undefined || PASSWORDS[user] !== password) {
    return await op.resumeAuthorization(id, {
      deny: { error: "access_denied", description: "wrong user or password" },
    });
  }
  const signedIn: Session = {
    user,
    authTime: Math.floor(Date.now() / 1000),
    sessionId: OpenIdProvider.newSessionId(),
  };
  const response = await op.resumeAuthorization(id, {
    grant: {
      subject: user,
      authTime: signedIn.authTime,
      sessionId: signedIn.sessionId,
      amr: ["pwd"],
    },
  });
  sealer ??= CookieSealer.create({ secret: c.env.COOKIE_SECRET });
  response.headers.append(
    "set-cookie",
    setCookie(
      COOKIE,
      await (await sealer).seal(COOKIE, signedIn, SESSION_SEC),
      {
        maxAgeSec: SESSION_SEC,
        secure: c.url.protocol === "https:",
      },
    ),
  );
  return response;
});

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/login") return await app.fetch(request, env, ctx);
    const op = await provider(url.origin, env);
    const response = await op.handle(request);
    if (response === null) return new Response("not found", { status: 404 });
    if (url.pathname === "/end_session" && response.status === 303) {
      response.headers.append(
        "set-cookie",
        clearCookie(COOKIE, { secure: url.protocol === "https:" }),
      );
    }
    return response;
  },
};
