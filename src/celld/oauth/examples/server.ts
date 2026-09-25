// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A complete OAuth 2.1 authorization server in one Worker, with its
 * records (codes, refresh token families, pushed requests, interactions,
 * revocations, client assertion `jti`s) in the `OAuthRecords` Durable
 * Object, and a small notes API beside it that accepts its tokens.
 *
 * Authorization server (the issuer is the Worker's origin):
 *
 * - `GET /.well-known/oauth-authorization-server`: RFC 8414 metadata.
 * - `POST /par`: pushed authorization requests (RFC 9126).
 * - `GET /authorize`: validates the request, then the interaction hook
 *   sends the browser to the host's login page, `/login?i=<id>`.
 * - `GET /login?i=`, `POST /login`: the host's login page, a stub (one
 *   user, `ada`, whose password is `DEMO_PASSWORD`; no CSRF token or
 *   session, which a real page needs). A good password resumes the
 *   authorization: a 303 to the client's redirect URI with the code.
 * - `POST /token`: the code with PKCE S256, and refresh tokens, which
 *   rotate; a reused code or refresh token revokes what it issued.
 * - `POST /revoke`, `POST /introspect` (RFC 7009, RFC 7662), `GET /jwks`.
 *
 * Clients: `cli`, public, redirecting to `http://127.0.0.1:8765/callback`;
 * `reporter`, confidential (`client_secret_basic`, `REPORTER_SECRET`),
 * which may introspect. Access tokens are ES256 JWTs signed with
 * `SIGNING_JWK`, so they outlive a restart; their audience is `/api`.
 *
 * Notes API, on `@celld/router` with oauth's `ResourceServer` behind its
 * `bearer` scheme (`@celld/oauth/router`; the resource takes no DPoP, so
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
 * buck2 run root//src/celld/oauth/examples:server-dev
 * curl -sS localhost:9876/.well-known/oauth-authorization-server
 * curl -sS localhost:9876/par -d client_id=cli -d response_type=code \
 *   -d redirect_uri=http://127.0.0.1:8765/callback -d scope=notes:read \
 *   -d code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM \
 *   -d code_challenge_method=S256
 * ```
 *
 * @module
 */

import type { Jwk } from "@celld/jwt";
import { ProtocolError } from "@celld/oauth";
import { durableRecordStore, type RecordStoreApi } from "@celld/oauth/durable";
import {
  type AccessTokenVerifier,
  ResourceServer,
  scopesOf,
} from "@celld/oauth/resource";
import { AuthorizationServer, signingKeyFromJwk } from "@celld/oauth/server";
import { oauthSchemes, protectedResourceRoutes } from "@celld/oauth/router";
import { router } from "@celld/router";
import { v } from "@celld/sieve";

export { OAuthRecords } from "@celld/oauth/durable";

interface Env {
  readonly OAUTH_RECORDS: DurableObjectNamespace<RecordStoreApi>;
  /**
   * The access token signing key: a private ES256 JWK with a `kid`, as
   * JSON.
   */
  readonly SIGNING_JWK: string;
  readonly REPORTER_SECRET: string;
  readonly DEMO_PASSWORD: string;
}

interface World {
  readonly server: AuthorizationServer;
  readonly resource: ResourceServer;
  readonly api: {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  };
}

const worlds = new Map<string, Promise<World>>();

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
    interaction: ({ interactionId }) =>
      new Response(null, {
        status: 303,
        headers: { location: `/login?i=${encodeURIComponent(interactionId)}` },
      }),
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
  return { server, resource, api: app };
}

async function login(
  world: World,
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method === "GET") {
    const id = new URL(request.url).searchParams.get("i") ?? "";
    const pending = await world.server.interaction(id);
    if (pending === null) return page(400, "<p>This sign-in has expired.</p>");
    return page(
      200,
      `<h1>Sign in to ${escape(pending.client.client_id)}</h1>` +
        `<p>It asks for: ${escape(pending.scope.join(", "))}</p>` +
        `<form method="post" action="/login"><input type="hidden" name="i" value="${
          escape(id)
        }">` +
        `<input name="user"><input name="password" type="password">` +
        `<button name="decision" value="allow">Allow</button>` +
        `<button name="decision" value="deny">Deny</button></form>`,
    );
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
  }
  const form = new URLSearchParams(await request.text());
  const id = form.get("i") ?? "";
  if (form.get("decision") === "deny") {
    return await world.server.resumeAuthorization(id, { deny: {} });
  }
  if (
    form.get("user") !== "ada" || form.get("password") !== env.DEMO_PASSWORD
  ) {
    return page(401, "<p>Wrong user or password.</p>");
  }
  return await world.server.resumeAuthorization(id, {
    grant: { subject: "ada", authTime: Math.floor(Date.now() / 1000) },
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    let world = worlds.get(url.origin);
    if (world === undefined) {
      world = build(url.origin, env);
      worlds.set(url.origin, world);
    }
    const w = await world;
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname === w.resource.metadataPath
    ) {
      return await w.api.fetch(request, env, ctx);
    }
    if (url.pathname === "/login") return await login(w, request, env);
    return await w.server.handle(request) ??
      new Response("not found", { status: 404 });
  },
};
