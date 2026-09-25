// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An OpenID Provider Worker: `OpenIdProvider` with its records (codes,
 * refresh token families, login sessions, pushed requests) in the
 * `OAuthRecords` Durable Object, and the host's part (a login page, a
 * logout page and a session cookie) around it.
 *
 * - `GET /.well-known/openid-configuration`, `/authorize`, `/par`,
 *   `/token`, `/jwks`, `/userinfo`, `/end_session`, `/revoke`,
 *   `/introspect`: the provider's endpoints. The issuer is `ISSUER`,
 *   which a deployment sets; without it (development only) the issuer is
 *   the request's origin, and only when its host is a loopback IP
 *   literal, so a `Host` header cannot name a new issuer.
 * - `GET /login?i=<interaction>`: the login page the interaction hook
 *   sends browsers to. The hook also sets the short-lived, sealed
 *   `op_interaction` cookie naming the interaction, so only the browser
 *   that started it can see or finish it; the page carries a CSRF token.
 *   Under an https issuer both cookies are `__Host-op_interaction` and
 *   `__Host-op_session` (Secure, no Domain), so a sibling subdomain
 *   cannot plant its own session in a victim's browser and have the
 *   victim silently signed in as the attacker.
 * - `POST /login` (`i`, `user`, `password`, `_csrf`): a declared, bounded
 *   form (`LOGIN_FORM`: those fields only, each once, each short; the
 *   route's body limit is 2 KiB), checked by the router's CSRF policy
 *   (`Origin`/`Sec-Fetch-Site` and the double-submit token) and against
 *   the `op_interaction` cookie. It signs the user in (the sealed
 *   `op_session` cookie) and resumes the authorization with `authTime`
 *   and a login session id, whose HMAC is the ID token's `sid`.
 * - `GET /logout`: a confirmation page with a form (and a CSRF token)
 *   that posts to `POST /logout`, which ends the login session and clears
 *   `op_session`. A GET never signs anyone out.
 *
 * The interaction hook grants at once to a browser with a session, unless
 * `prompt=login` or `max_age` says it must log in again; with
 * `prompt=none` it answers `login_required` instead of showing the page.
 * RP-initiated logout (`/end_session`) with a valid ID token hint for the
 * signed-in user ends that login session (`endSession` calls
 * `endLoginSession`) and clears `op_session`: its access tokens get no
 * more UserInfo and its refresh tokens no more tokens. Without a hint, or
 * with a hint from a browser that is not signed in as its user, it sends
 * the browser to the `/logout` confirmation page instead and ends
 * nothing, so neither a cross-site link nor an old ID token can sign the
 * user out. The one client, `web`, is
 * public, redirects to `http://127.0.0.1/cb` (any port, RFC 8252) and
 * comes back after logout to `http://127.0.0.1:8765/bye`.
 *
 * The signing key is `SIGNING_JWK`, a private JWK (JSON) kept as a secret,
 * so tokens outlive restarts. The one user's password is the secret
 * `DEMO_PASSWORD`. The password check is a stub: a real one compares a
 * slow password hash, and would never take a password over plain http.
 *
 * ```sh
 * buck2 run root//src/celld/sec/oidc/examples:provider-dev
 * curl -sS localhost:9876/.well-known/openid-configuration
 * ```
 *
 * @module
 */

import {
  durableRecordStore,
  type RecordStoreApi,
} from "@celld/sec/oauth/durable";
import { type SigningKey, signingKeyFromJwk } from "@celld/sec/oauth/server";
import { OpenIdProvider } from "@celld/sec/oidc/provider";
import {
  clearCookie,
  CookieSealer,
  readCookie,
  setCookie,
} from "@celld/sec/oidc/rp";
import { csrfToken, router } from "@celld/web/router";

export { OAuthRecords } from "@celld/sec/oauth/durable";

interface Env {
  readonly OAUTH_RECORDS: DurableObjectNamespace<RecordStoreApi>;
  /** The ES256 private JWK (with `kid`) that signs tokens, as JSON. */
  readonly SIGNING_JWK: string;
  /** 32 random bytes (base64url); seals the `op_session` and `op_interaction` cookies. */
  readonly COOKIE_SECRET: string;
  /** 32 random bytes (base64url); keys the `sid` claim (`OpenIdProvider.sessionSid`). */
  readonly SESSION_SID_KEY: string;
  /** The issuer origin, such as `https://login.example.com`; a deployment sets it. */
  readonly ISSUER?: string;
  /** The demo user `ada`'s password (a stub for a real password store). */
  readonly DEMO_PASSWORD?: string;
}

interface Session {
  readonly user: string;
  readonly authTime: number;
  readonly sessionId: string;
}

const USERS: ReadonlyMap<string, Readonly<Record<string, unknown>>> = new Map(
  [[
    "ada",
    {
      name: "Ada Lovelace",
      email: "ada@example.com",
      email_verified: true,
      phone_number: "+44 20 7946 0000",
    },
  ]],
);

/** Whether `password` is `user`'s. A Map, so `constructor` is no user. */
function passwordMatches(env: Env, user: string, password: string): boolean {
  const passwords = new Map([["ada", env.DEMO_PASSWORD]]);
  const expected = passwords.get(user);
  return expected !== undefined && expected !== "" && expected === password;
}

/** The session cookie's base name, which also binds its sealed value. */
const COOKIE = "op_session";
const SESSION_SEC = 8 * 3600;
/** Names the interaction this browser started; lives as long as the interaction. */
const INTERACTION = "op_interaction";
const INTERACTION_SEC = 600;

/**
 * A cookie's name: `__Host-` first when the issuer is https, so the
 * browser keeps it only from this origin (Secure, `Path=/`, no Domain).
 */
function cookieName(base: string, secure: boolean): string {
  return secure ? `__Host-${base}` : base;
}

/**
 * The login form, declared: each field's longest value. Nothing else may
 * be sent (but the router's `_csrf`), and each field exactly once.
 */
const LOGIN_FORM = { i: 64, user: 64, password: 256 } as const;

type LoginForm = { readonly [K in keyof typeof LOGIN_FORM]: string };

/** The login form's fields, or null when it is not exactly `LOGIN_FORM`. */
function loginForm(
  form: Readonly<Record<string, string | string[]>>,
): LoginForm | null {
  for (const name of Object.keys(form)) {
    if (name !== "_csrf" && !Object.hasOwn(LOGIN_FORM, name)) return null;
  }
  const out: Record<string, string> = {};
  for (const [name, max] of Object.entries(LOGIN_FORM)) {
    const value = form[name];
    if (typeof value !== "string" || value.length > max) return null;
    out[name] = value;
  }
  return out as LoginForm;
}

let key: Promise<SigningKey> | null = null;
let sealer: Promise<CookieSealer> | null = null;
/** The one provider, for the one issuer; never one per `Host`. */
let current: { readonly issuer: string; readonly op: OpenIdProvider } | null =
  null;
/** End-session requests whose browser session was ended, so its cookie is cleared. */
const signedOut = new WeakSet<Request>();

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function isLoopbackLiteral(hostname: string): boolean {
  return hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * The issuer: `ISSUER` when set. Otherwise, for development, the request's
 * origin when its host is a loopback IP literal, and null for any other
 * host (which is refused).
 */
function issuerOf(url: URL, env: Env): string | null {
  if (env.ISSUER !== undefined && env.ISSUER !== "") {
    const origin = new URL(env.ISSUER).origin;
    return url.origin === origin ? origin : null;
  }
  return isLoopbackLiteral(url.hostname) ? url.origin : null;
}

/** Whether cookies get `Secure`: the issuer is https. */
function isSecure(url: URL, env: Env): boolean {
  return issuerOf(url, env)?.startsWith("https:") === true;
}

function sealerOf(env: Env): Promise<CookieSealer> {
  sealer ??= CookieSealer.create({ secret: env.COOKIE_SECRET });
  return sealer;
}

async function session(request: Request, env: Env): Promise<Session | null> {
  const secure = isSecure(new URL(request.url), env);
  return await (await sealerOf(env)).unseal<Session>(
    COOKIE,
    readCookie(request.headers.get("cookie"), cookieName(COOKIE, secure)),
  );
}

/** Whether `request` comes from the browser that started interaction `id`. */
async function startedHere(
  request: Request,
  env: Env,
  id: string,
): Promise<boolean> {
  const secure = isSecure(new URL(request.url), env);
  const sealed = await (await sealerOf(env)).unseal<{ i: string }>(
    INTERACTION,
    readCookie(request.headers.get("cookie"), cookieName(INTERACTION, secure)),
  );
  return sealed !== null && id !== "" && sealed.i === id;
}

async function provider(url: URL, env: Env): Promise<OpenIdProvider> {
  const origin = issuerOf(url, env);
  // The fetch handler refuses such a request before it gets here.
  if (origin === null) throw new Error("not this provider's host");
  if (current !== null && current.issuer === origin) return current.op;
  key ??= signingKeyFromJwk(JSON.parse(env.SIGNING_JWK), "ES256");
  const secure = origin.startsWith("https:");
  const op: OpenIdProvider = new OpenIdProvider({
    issuer: origin,
    keys: [await key],
    store: durableRecordStore(env.OAUTH_RECORDS),
    sessionSidKey: env.SESSION_SID_KEY,
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
      // Bind the interaction to this browser: the login page and its POST
      // only work with this cookie.
      const bound = await (await sealerOf(env)).seal(
        INTERACTION,
        { i: context.interactionId },
        INTERACTION_SEC,
      );
      const headers = new Headers({
        location: `/login?i=${context.interactionId}`,
      });
      headers.append(
        "set-cookie",
        setCookie(cookieName(INTERACTION, secure), bound, {
          maxAgeSec: INTERACTION_SEC,
          secure,
        }),
      );
      return new Response(null, { status: 303, headers });
    },
    claims: ({ subject, claims }) =>
      Object.fromEntries(
        claims.flatMap((name) => {
          const user = USERS.get(subject);
          return user === undefined || !Object.hasOwn(user, name)
            ? []
            : [[name, user[name]]];
        }),
      ),
    // RP-initiated logout. With a valid hint for the signed-in user, end
    // this browser's login session too and let the provider finish (it
    // ends the hint's session and redirects); the cookie is cleared on the
    // way out. Without a hint, or from a browser that is not signed in as
    // the hint's user, ask on the confirmation page: the provider ends
    // nothing then, so neither a link nor an old ID token (RPs log them,
    // and they travel in URLs) signs anyone out.
    endSession: async (context) => {
      const current = context.subject === undefined
        ? null
        : await session(context.request, env);
      if (current === null || current.user !== context.subject) {
        return new Response(null, {
          status: 303,
          headers: { location: "/logout" },
        });
      }
      await op.endLoginSession(current.sessionId);
      signedOut.add(context.request);
    },
  });
  current = { issuer: origin, op };
  return op;
}

function page(title: string, body: string): string {
  return `<!doctype html><title>${escape(title)}</title>${body}`;
}

// Deliberately unauthenticated: this router serves only the login and
// logout pages, which anyone may open. They are protected by the
// `op_interaction` cookie and the CSRF checks, not by a caller identity.
// The provider's own endpoints (outside this router) authenticate their
// clients themselves.
const app = router<Env>({ auth: "none", csrf: { token: true } });

app.get("/login", async (c) => {
  const op = await provider(c.url, c.env);
  const id = c.url.searchParams.get("i") ?? "";
  if (!(await startedHere(c.req, c.env, id))) {
    return c.fail(400, "this browser did not start the sign-in");
  }
  const pending = await op.interaction(id);
  if (pending === null) return c.fail(400, "the sign-in request expired");
  const token = csrfToken(c);
  return c.html(page(
    "Sign in",
    `<p>Sign in to ${
      escape(pending.client.client_id)
    }</p><form method="post"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="i" value="${
      escape(id)
    }"><input name="user" maxlength="${LOGIN_FORM.user}"><input name="password" type="password" maxlength="${LOGIN_FORM.password}"><button>Sign in</button></form>`,
  ));
});

app.post("/login", {
  csrf: true,
  bodyType: "form",
  limits: { body: 2048, jsonKeys: 8 },
}, async (c) => {
  const form = loginForm(await c.readForm());
  if (form === null) return c.fail(400, "the sign-in form is malformed");
  if (!(await startedHere(c.req, c.env, form.i))) {
    return c.fail(400, "this browser did not start the sign-in");
  }
  const op = await provider(c.url, c.env);
  const secure = isSecure(c.url, c.env);
  const done = (response: Response) => {
    response.headers.append(
      "set-cookie",
      clearCookie(cookieName(INTERACTION, secure), { secure }),
    );
    return response;
  };
  if (!passwordMatches(c.env, form.user, form.password)) {
    return done(
      await op.resumeAuthorization(form.i, {
        deny: { error: "access_denied", description: "wrong user or password" },
      }),
    );
  }
  const signedIn: Session = {
    user: form.user,
    authTime: Math.floor(Date.now() / 1000),
    sessionId: OpenIdProvider.newSessionId(),
  };
  const response = done(
    await op.resumeAuthorization(form.i, {
      grant: {
        subject: form.user,
        authTime: signedIn.authTime,
        sessionId: signedIn.sessionId,
        amr: ["pwd"],
      },
    }),
  );
  response.headers.append(
    "set-cookie",
    setCookie(
      cookieName(COOKIE, secure),
      await (await sealerOf(c.env)).seal(COOKIE, signedIn, SESSION_SEC),
      { maxAgeSec: SESSION_SEC, secure },
    ),
  );
  return response;
});

app.get("/logout", (c) =>
  c.html(page(
    "Sign out",
    `<form method="post" action="/logout"><input type="hidden" name="_csrf" value="${
      csrfToken(c)
    }"><button>Sign out</button></form>`,
  )));

app.post("/logout", {
  csrf: true,
  bodyType: "form",
  limits: { body: 256, jsonKeys: 2 },
}, async (c) => {
  const current = await session(c.req, c.env);
  if (current !== null) {
    const op = await provider(c.url, c.env);
    await op.endLoginSession(current.sessionId);
  }
  const secure = isSecure(c.url, c.env);
  c.header("set-cookie", clearCookie(cookieName(COOKIE, secure), { secure }));
  return c.html(page("Signed out", "<p>You are signed out.</p>"));
});

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const issuer = issuerOf(url, env);
    if (issuer === null) {
      return new Response("not this provider's host", { status: 421 });
    }
    if (url.pathname === "/login" || url.pathname === "/logout") {
      return await app.fetch(request, env, ctx);
    }
    const op = await provider(url, env);
    const response = await op.handle(request);
    if (response === null) return new Response("not found", { status: 404 });
    if (signedOut.has(request)) {
      const secure = issuer.startsWith("https:");
      response.headers.append(
        "set-cookie",
        clearCookie(cookieName(COOKIE, secure), { secure }),
      );
    }
    return response;
  },
};
