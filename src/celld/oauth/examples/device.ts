// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The device authorization grant (RFC 8628): a TV app with no browser
 * signs in by showing a short code the user types on their phone.
 *
 * - `POST /device_authorization`: the TV (`client_id=tv`, a public client)
 *   gets a `device_code` it keeps and a `user_code` it shows, with the
 *   verification URI and the polling interval.
 * - `POST /token` with the device code grant: `authorization_pending`
 *   until the user decides, `slow_down` (and five more seconds of
 *   interval) when polled too fast, then the tokens once, then
 *   `invalid_grant`; `access_denied` when the user said no.
 * - `GET /device?user_code=`: the host's verification page, showing what
 *   the code asks for (404 for a code that is unknown, expired or
 *   decided). `POST /device` with `user_code`, `user` and `decision`
 *   (`approve` or `deny`) records the decision. It is a stub: a real page
 *   signs the user in and checks a CSRF token.
 *
 * Device codes, user codes and their decisions are records in the
 * `OAuthRecords` Durable Object; user codes are eight letters without
 * vowels, typed with or without the dash, and spent by the first
 * decision so a guessed code cannot be tried twice. Access tokens are
 * signed with `SIGNING_JWK` and name `/media` as their audience.
 *
 * ```sh
 * buck2 run root//src/celld/oauth/examples:device-dev
 * curl -sS localhost:9876/device_authorization -d client_id=tv -d scope=media:play
 * ```
 *
 * @module
 */

import type { Jwk } from "@celld/jwt";
import { durableRecordStore, type RecordStoreApi } from "@celld/oauth/durable";
import { AuthorizationServer, signingKeyFromJwk } from "@celld/oauth/server";

export { OAuthRecords } from "@celld/oauth/durable";

interface Env {
  readonly OAUTH_RECORDS: DurableObjectNamespace<RecordStoreApi>;
  /** A private ES256 JWK with a `kid`, as JSON. */
  readonly SIGNING_JWK: string;
}

const servers = new Map<string, Promise<AuthorizationServer>>();

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(status: number, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Connect a device</title></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; form-action 'self'",
      },
    },
  );
}

async function build(origin: string, env: Env): Promise<AuthorizationServer> {
  const jwk = JSON.parse(env.SIGNING_JWK) as Jwk;
  return new AuthorizationServer({
    issuer: origin,
    keys: [await signingKeyFromJwk(jwk, "ES256")],
    store: durableRecordStore(env.OAUTH_RECORDS),
    clients: [{
      client_id: "tv",
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
    }],
    scopesSupported: ["media:play", "media:purchase"],
    resources: { default: [`${origin}/media`] },
    device: { verificationUri: `${origin}/device` },
    interaction: () => ({
      deny: { description: "this server has no browser flow" },
    }),
  });
}

async function verification(
  server: AuthorizationServer,
  request: Request,
): Promise<Response> {
  if (request.method === "GET") {
    const code = new URL(request.url).searchParams.get("user_code") ?? "";
    const pending = await server.device(code);
    if (pending === null) {
      return page(404, "<p>That code is unknown, expired or already used.</p>");
    }
    return page(
      200,
      `<h1>Connect ${escape(pending.client.client_id)}</h1>` +
        `<p>It asks for: ${escape(pending.scope.join(", "))}</p>` +
        `<form method="post" action="/device"><input type="hidden" name="user_code" value="${
          escape(code)
        }">` +
        `<input name="user"><button name="decision" value="approve">Approve</button>` +
        `<button name="decision" value="deny">Deny</button></form>`,
    );
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
  }
  const form = new URLSearchParams(await request.text());
  const code = form.get("user_code") ?? "";
  const user = form.get("user") ?? "";
  const approve = form.get("decision") === "approve";
  if (approve && user === "") return page(400, "<p>Sign in first.</p>");
  const decided = await server.decideDevice(
    code,
    approve
      ? { grant: { subject: user, authTime: Math.floor(Date.now() / 1000) } }
      : { deny: {} },
  );
  if (!decided) {
    return page(404, "<p>That code is unknown, expired or already used.</p>");
  }
  return page(
    200,
    approve
      ? "<p>Approved. You can go back to your TV.</p>"
      : "<p>Denied. The TV will not be signed in.</p>",
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let server = servers.get(url.origin);
    if (server === undefined) {
      server = build(url.origin, env);
      servers.set(url.origin, server);
    }
    if (url.pathname === "/device") {
      return await verification(await server, request);
    }
    return await (await server).handle(request) ??
      new Response("not found", { status: 404 });
  },
};
