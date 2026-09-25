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
 *   decided), with a CSRF token. `POST /device` with `user_code`,
 *   `user`, `password` and `decision` (`approve` or `deny`) records the
 *   decision: a declared form of 1 KiB at most, checked by the router's
 *   CSRF policy (`Origin`/`Sec-Fetch-Site` and the double-submit token).
 *   Approving needs the password of the one user, `ada`
 *   (`DEMO_PASSWORD`), so holding a user code is not enough to sign a TV
 *   in as someone; a wrong password is 401 and leaves the code unspent.
 *   The password check is a stub: a real page signs the user in (a slow
 *   password hash, a session) before showing the form.
 *
 * The issuer is `ISSUER` when set, as a deployment must; without it
 * (development) it is the request's origin, and only a loopback address
 * is served, so the `Host` header cannot pick an issuer (421 otherwise).
 *
 * Device codes, user codes and their decisions are records in the
 * `OAuthRecords` Durable Object; user codes are eight letters without
 * vowels, typed with or without the dash, and spent by the first
 * decision so a guessed code cannot be tried twice. Access tokens are
 * signed with `SIGNING_JWK` and name `/media` as their audience.
 *
 * ```sh
 * buck2 run root//src/celld/sec/oauth/examples:device-dev
 * curl -sS 127.0.0.1:9876/device_authorization -d client_id=tv -d scope=media:play
 * ```
 *
 * @module
 */

import type { Jwk } from "@celld/sec/jwt";
import {
  durableRecordStore,
  type RecordStoreApi,
} from "@celld/sec/oauth/durable";
import {
  AuthorizationServer,
  signingKeyFromJwk,
} from "@celld/sec/oauth/server";
import { csrfToken, router, secretEquals } from "@celld/web/router";

export { OAuthRecords } from "@celld/sec/oauth/durable";

interface Env {
  readonly OAUTH_RECORDS: DurableObjectNamespace<RecordStoreApi>;
  /** A private ES256 JWK with a `kid`, as JSON. */
  readonly SIGNING_JWK: string;
  /** The password of the one user, `ada`. */
  readonly DEMO_PASSWORD: string;
  /** The issuer (this Worker's public origin); a deployment sets it. */
  readonly ISSUER?: string;
}

/** The one server this isolate runs, for its one issuer. */
let current: {
  readonly issuer: string;
  readonly server: Promise<{
    readonly server: AuthorizationServer;
    readonly pages: Handler;
  }>;
} | null = null;

interface Handler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
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
    resources: { default: [`${origin}/media`], allowed: [`${origin}/media`] },
    device: { verificationUri: `${origin}/device` },
    interaction: () => ({
      deny: { description: "this server has no browser flow" },
    }),
  });
}

/**
 * The verification form, declared: each field's longest value. Nothing
 * else may be sent (but the router's `_csrf`), and each field at most
 * once; `user` and `password` are needed only to approve.
 */
const DEVICE_FORM = {
  user_code: 16,
  user: 64,
  password: 256,
  decision: 7,
} as const;

type DeviceForm = { readonly [K in keyof typeof DEVICE_FORM]: string };

/** The verification form's fields, or null when it breaks `DEVICE_FORM`. */
function deviceForm(
  form: Readonly<Record<string, string | string[]>>,
): DeviceForm | null {
  for (const name of Object.keys(form)) {
    if (name !== "_csrf" && !Object.hasOwn(DEVICE_FORM, name)) return null;
  }
  const out: Record<string, string> = {};
  for (const [name, max] of Object.entries(DEVICE_FORM)) {
    const value = form[name] ?? "";
    if (typeof value !== "string" || value.length > max) return null;
    out[name] = value;
  }
  return out as DeviceForm;
}

/**
 * The verification page. The router is deliberately unauthenticated
 * (`auth: "none"`): the user signs in on the form itself. Without the
 * password an anonymous caller can see what a user code it holds asks for
 * and deny it, but cannot approve it; the POST is CSRF-checked.
 */
function verification(server: AuthorizationServer): Handler {
  const pages = router<Env>({ auth: "none", csrf: { token: true } });
  pages.get("/device", async (c) => {
    const code = c.url.searchParams.get("user_code") ?? "";
    const pending = await server.device(code);
    if (pending === null) {
      return page(404, "<p>That code is unknown, expired or already used.</p>");
    }
    return page(
      200,
      `<h1>Connect ${escape(pending.client.client_id)}</h1>` +
        `<p>It asks for: ${escape(pending.scope.join(", "))}</p>` +
        `<form method="post" action="/device">` +
        `<input type="hidden" name="_csrf" value="${csrfToken(c)}">` +
        `<input type="hidden" name="user_code" value="${escape(code)}">` +
        `<input name="user" maxlength="${DEVICE_FORM.user}">` +
        `<input name="password" type="password" maxlength="${DEVICE_FORM.password}">` +
        `<button name="decision" value="approve">Approve</button>` +
        `<button name="decision" value="deny">Deny</button></form>`,
    );
  });
  pages.post("/device", {
    csrf: true,
    bodyType: "form",
    limits: { body: 1024, jsonKeys: 8 },
  }, async (c) => {
    const form = deviceForm(await c.readForm());
    if (form === null || !["approve", "deny"].includes(form.decision)) {
      return c.fail(400, "the form is malformed");
    }
    const approve = form.decision === "approve";
    if (approve) {
      const good = form.user === "ada" &&
        await secretEquals(form.password, c.env.DEMO_PASSWORD);
      if (!good) return page(401, "<p>Wrong user or password.</p>");
    }
    const decided = await server.decideDevice(
      form.user_code,
      approve
        ? { grant: { subject: "ada", authTime: Math.floor(Date.now() / 1000) } }
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
      current = {
        issuer,
        server: build(issuer, env).then((server) => ({
          server,
          pages: verification(server),
        })),
      };
    }
    const { server, pages } = await current.server;
    if (url.pathname === "/device") return await pages.fetch(request, env, ctx);
    return await server.handle(request) ??
      new Response("not found", { status: 404 });
  },
};
