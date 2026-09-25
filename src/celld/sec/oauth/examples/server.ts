// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A complete OAuth 2.1 authorization server in one Worker, with its
 * records (codes, refresh token families, pushed requests, interactions,
 * revocations, client assertion `jti`s) in the `OAuthRecords` Durable
 * Object, and a small notes API beside it that accepts its tokens.
 *
 * Authorization server. Its issuer is `ISSUER` when set, as a deployment
 * must; without it (development) the issuer is the request's origin, and
 * only a loopback address (`127.0.0.1`, `[::1]`) is served, so the `Host`
 * header cannot pick an issuer (421 for any other):
 *
 * - `GET /.well-known/oauth-authorization-server`: RFC 8414 metadata.
 * - `POST /par`: pushed authorization requests (RFC 9126).
 * - `GET /authorize`: validates the request, then the interaction hook
 *   sends the browser to the host's login page, `/login?i=<id>`.
 * - `GET /login?i=`, `POST /login`: the host's login page (one user,
 *   `ada`, whose password is `DEMO_PASSWORD`). The interaction hook sets
 *   the short-lived, encrypted `oauth_interaction` cookie naming the
 *   interaction (`COOKIE_SECRET`), so only the browser that started it
 *   can open the page or post it. The POST is a declared form (`i`,
 *   `user`, `password`, `decision`; 2 KiB at most) checked by the
 *   router's CSRF policy (`Origin`/`Sec-Fetch-Site` and the page's
 *   double-submit token). A good password resumes the authorization: a
 *   303 to the client's redirect URI with the code. The password check is
 *   a stub: a real one compares a slow password hash.
 * - `POST /token`: the code with PKCE S256, and refresh tokens, which
 *   rotate; a reused code or refresh token revokes what it issued.
 * - `POST /revoke`, `POST /introspect` (RFC 7009, RFC 7662), `GET /jwks`.
 *
 * Clients: `cli`, public, redirecting to `http://127.0.0.1:8765/callback`;
 * `reporter`, confidential (`client_secret_basic`, `REPORTER_SECRET`),
 * which may introspect tokens for the API (the `introspection` policy;
 * without one no client may). Access tokens are ES256 JWTs signed with
 * `SIGNING_JWK`, so they outlive a restart; their audience is `/api`.
 *
 * Notes API, on `@celld/web/router` with oauth's `ResourceServer` behind its
 * `bearer` scheme (`@celld/sec/oauth/router`; the resource takes no DPoP, so
 * there is no `dpop` scheme). Its challenges carry RFC 9728's
 * `resource_metadata`:
 *
 * - `GET /.well-known/oauth-protected-resource/api`: RFC 9728 metadata,
 *   a public route from `protectedResourceRoutes`.
 * - `GET /api/notes` (`notes:read`), `POST /api/notes` (`notes:write`).
 *
 * The API checks tokens with the server in the same Worker, so it sees
 * revocations at once; an API elsewhere verifying the JWT against
 * `/jwks` would accept a revoked token until it expires (five minutes),
 * or would ask `/introspect`.
 *
 * ```sh
 * buck2 run root//src/celld/sec/oauth/examples:server-dev
 * curl -sS 127.0.0.1:9876/.well-known/oauth-authorization-server
 * curl -sS 127.0.0.1:9876/par -d client_id=cli -d response_type=code \
 *   -d redirect_uri=http://127.0.0.1:8765/callback -d scope=notes:read \
 *   -d code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM \
 *   -d code_challenge_method=S256
 * ```
 *
 * @module
 */

import type { Jwk } from "@celld/sec/jwt";
import { ProtocolError } from "@celld/sec/oauth";
import {
  durableRecordStore,
  type RecordStoreApi,
} from "@celld/sec/oauth/durable";
import {
  type AccessTokenVerifier,
  ResourceServer,
  scopesOf,
} from "@celld/sec/oauth/resource";
import {
  AuthorizationServer,
  signingKeyFromJwk,
} from "@celld/sec/oauth/server";
import { oauthSchemes, protectedResourceRoutes } from "@celld/sec/oauth/router";
import {
  type CookieKeyring,
  cookieKeys,
  csrfToken,
  router,
  secretEquals,
  serializeCookie,
} from "@celld/web/router";
import { v } from "@celld/sieve";

export { OAuthRecords } from "@celld/sec/oauth/durable";

interface Env {
  readonly OAUTH_RECORDS: DurableObjectNamespace<RecordStoreApi>;
  /**
   * The access token signing key: a private ES256 JWK with a `kid`, as
   * JSON.
   */
  readonly SIGNING_JWK: string;
  readonly REPORTER_SECRET: string;
  readonly DEMO_PASSWORD: string;
  /** At least 32 bytes; encrypts the `oauth_interaction` cookie. */
  readonly COOKIE_SECRET: string;
  /** The issuer (this Worker's public origin); a deployment sets it. */
  readonly ISSUER?: string;
}

interface World {
  readonly server: AuthorizationServer;
  readonly resource: ResourceServer;
  readonly api: Handler;
  readonly pages: Handler;
}

interface Handler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

/** The one world this isolate serves, for its one issuer. */
let current:
  | { readonly issuer: string; readonly world: Promise<World> }
  | null = null;

/** Names the interaction this browser started; lives as long as the interaction. */
const INTERACTION = "oauth_interaction";
const INTERACTION_SEC = 600;

/**
 * The login form, declared: each field's longest value. Nothing else may
 * be sent (but the router's `_csrf`), and each field exactly once.
 */
const LOGIN_FORM = { i: 64, user: 64, password: 256, decision: 5 } as const;

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

/**
 * The issuer for `url`: `ISSUER` when set; otherwise the request's origin,
 * but only on a loopback address (development). Null for anything else.
 */
function issuerFor(url: URL, env: Env): string | null {
  if (env.ISSUER !== undefined && env.ISSUER !== "") return env.ISSUER;
  return /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/.test(url.hostname)
    ? url.origin
    : null;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(status: number, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; form-action 'self'",
        "x-frame-options": "DENY",
      },
    },
  );
}

/** The server's own check, which sees revocations, as a resource server verifier. */
function localVerifier(
  server: AuthorizationServer,
  audience: string,
): AccessTokenVerifier {
  return {
    async verify(token) {
      const claims = await server.verifyAccessToken(token);
      const invalid = (description: string) =>
        new ProtocolError("invalid_token", { status: 401, description });
      if (claims === null) {
        throw invalid("the token is invalid, expired or revoked");
      }
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.includes(audience)) {
        throw invalid("the token is for another resource");
      }
      const cnf = claims.cnf as { jkt?: string } | undefined;
      return {
        subject: claims.sub as string,
        scopes: scopesOf(claims),
        clientId: claims.client_id as string,
        issuer: claims.iss as string,
        audience: aud as string[],
        expiresAt: (claims.exp as number) * 1000,
        ...(cnf === undefined ? {} : { cnf }),
        claims,
      };
    },
  };
}

const Note = v.object({ text: v.string().min(1).max(280) });

async function build(origin: string, env: Env): Promise<World> {
  const api = `${origin}/api`;
  const keys = cookieKeys([{ id: "k1", secret: env.COOKIE_SECRET }]);
  const secure = origin.startsWith("https:");
  const server = new AuthorizationServer({
    issuer: origin,
    keys: [
      await signingKeyFromJwk(JSON.parse(env.SIGNING_JWK) as Jwk, "ES256"),
    ],
    store: durableRecordStore(env.OAUTH_RECORDS),
    clients: [
      { client_id: "cli", redirect_uris: ["http://127.0.0.1:8765/callback"] },
      {
        client_id: "reporter",
        client_secret: env.REPORTER_SECRET,
        grant_types: ["client_credentials"],
      },
    ],
    scopesSupported: ["notes:read", "notes:write"],
    resources: { allowed: [api], default: [api] },
    introspection: { audiences: { reporter: [api] } },
    // Bind the interaction to this browser: the login page and its POST
    // only work with this cookie.
    interaction: async ({ interactionId }) => {
      const headers = new Headers({
        location: `/login?i=${encodeURIComponent(interactionId)}`,
      });
      headers.append(
        "set-cookie",
        serializeCookie(
          INTERACTION,
          await keys.seal(INTERACTION, interactionId),
          { maxAge: INTERACTION_SEC, secure },
        ),
      );
      return new Response(null, { status: 303, headers });
    },
  });
  const resource = new ResourceServer({
    resource: api,
    authorizationServers: [origin],
    verifier: localVerifier(server, api),
    scopesSupported: ["notes:read", "notes:write"],
    dpop: false,
  });
  const app = router<Env>({ auth: oauthSchemes(resource) });
  protectedResourceRoutes(app, resource);
  app.get("/api/notes", { scopes: ["notes:read"] }, (c) =>
    c.json({
      owner: c.principal.subject,
      client: c.principal.clientId ?? null,
      notes: [{ text: "buy oat milk" }],
    }));
  app.post(
    "/api/notes",
    { scopes: ["notes:write"], body: Note },
    (c) => c.json({ owner: c.principal.subject, saved: c.body.text }, 201),
  );
  return {
    server,
    resource,
    api: app,
    pages: loginPages(server, keys, secure),
  };
}

/** Whether `c` comes from the browser that started interaction `id`. */
async function startedHere(
  c: { cookie(name: string): string | undefined },
  keys: CookieKeyring,
  id: string,
): Promise<boolean> {
  const sealed = c.cookie(INTERACTION);
  if (sealed === undefined || id === "") return false;
  const opened = await keys.unseal(INTERACTION, sealed);
  return opened !== null && opened.value === id;
}

/**
 * The login page. The router is deliberately unauthenticated (`auth:
 * "none"`): nobody is signed in yet. What protects it is the
 * `oauth_interaction` cookie, which only the browser that started the
 * interaction holds, and the CSRF check on the POST; an anonymous caller
 * without that cookie can neither see a pending request nor resume it.
 */
function loginPages(
  server: AuthorizationServer,
  keys: CookieKeyring,
  secure: boolean,
): Handler {
  const pages = router<Env>({ auth: "none", csrf: { token: true } });
  pages.get("/login", async (c) => {
    const id = c.url.searchParams.get("i") ?? "";
    if (!(await startedHere(c, keys, id))) {
      return c.fail(400, "this browser did not start the sign-in");
    }
    const pending = await server.interaction(id);
    if (pending === null) return page(400, "<p>This sign-in has expired.</p>");
    return page(
      200,
      `<h1>Sign in to ${escape(pending.client.client_id)}</h1>` +
        `<p>It asks for: ${escape(pending.scope.join(", "))}</p>` +
        `<form method="post" action="/login">` +
        `<input type="hidden" name="_csrf" value="${csrfToken(c)}">` +
        `<input type="hidden" name="i" value="${escape(id)}">` +
        `<input name="user" maxlength="${LOGIN_FORM.user}">` +
        `<input name="password" type="password" maxlength="${LOGIN_FORM.password}">` +
        `<button name="decision" value="allow">Allow</button>` +
        `<button name="decision" value="deny">Deny</button></form>`,
    );
  });
  pages.post("/login", {
    csrf: true,
    bodyType: "form",
    limits: { body: 2048, jsonKeys: 8 },
  }, async (c) => {
    const form = loginForm(await c.readForm());
    if (form === null || !["allow", "deny"].includes(form.decision)) {
      return c.fail(400, "the sign-in form is malformed");
    }
    if (!(await startedHere(c, keys, form.i))) {
      return c.fail(400, "this browser did not start the sign-in");
    }
    if (form.decision === "allow") {
      const good = form.user === "ada" &&
        await secretEquals(form.password, c.env.DEMO_PASSWORD);
      if (!good) return page(401, "<p>Wrong user or password.</p>");
    }
    // The interaction is decided: the binding has done its work.
    c.deleteCookie(INTERACTION, { secure });
    return await server.resumeAuthorization(
      form.i,
      form.decision === "deny" ? { deny: {} } : {
        grant: { subject: "ada", authTime: Math.floor(Date.now() / 1000) },
      },
    );
  });
  return pages;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const issuer = issuerFor(url, env);
    if (issuer === null) {
      return new Response("not an issuer here", { status: 421 });
    }
    if (current?.issuer !== issuer) {
      current = { issuer, world: build(issuer, env) };
    }
    const w = await current.world;
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname === w.resource.metadataPath
    ) {
      return await w.api.fetch(request, env, ctx);
    }
    if (url.pathname === "/login") {
      return await w.pages.fetch(request, env, ctx);
    }
    return await w.server.handle(request) ??
      new Response("not found", { status: 404 });
  },
};
