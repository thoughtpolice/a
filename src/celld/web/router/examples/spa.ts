// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An API for a single-page app on another origin: CORS for the listed
 * origins only.
 *
 * The SPA at `SPA_ORIGIN` calls this API with `fetch` and a bearer token.
 * `cors()` runs first on the router, so a preflight (`OPTIONS` with
 * `Access-Control-Request-Method`) is answered before authentication,
 * which a preflight never carries. Answers to the SPA carry
 * `Access-Control-Allow-Origin` with its exact origin, 401s included, so
 * the app can read why it was refused. Any other origin's preflight is a
 * 403 and its answers carry no CORS headers, so the browser keeps them
 * from its scripts; every answer has `Vary: Origin`. CORS is not access
 * control: a request without a token is still a 401, from any origin.
 *
 * - `GET /api/status`: public.
 * - `GET /api/profile`, `PUT /api/profile` (`{displayName}`): the token's
 *   user, stored under a domain-separated HMAC of the principal's `key`, never its
 *   `subject` (see the router README).
 *
 * `API_TOKENS` is set by the spec's `vars` for `celld dev` (a public
 * example token); unset, every token is refused.
 *
 * ```sh
 * buck2 run root//src/celld/web/router/examples:spa-dev
 * curl -sS -X OPTIONS 127.0.0.1:9876/api/profile -H 'origin: https://app.example.com' \
 *   -H 'access-control-request-method: PUT' -H 'access-control-request-headers: authorization, content-type' -i
 * ```
 *
 * @module
 */

import {
  bearer,
  cors,
  hashApiKey,
  type PrincipalInput,
  router,
} from "@celld/web/router";
import { v } from "@celld/sieve";
import { opaqueIdentity } from "@celld/core/bounds";

interface Env {
  readonly IDENTITY_SECRET: string;
  readonly SPA_ORIGIN: string;
  /** `{"<sha256 of token>": {"subject": ...}}` */
  readonly API_TOKENS?: string;
  readonly PROFILES: KVNamespace;
}

function build(env: Env) {
  if (
    typeof env.IDENTITY_SECRET !== "string" ||
    new TextEncoder().encode(env.IDENTITY_SECRET).length < 32
  ) throw new TypeError("IDENTITY_SECRET must contain at least 32 bytes");
  const identityKey = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.IDENTITY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const tokens = new Map<string, PrincipalInput>(
    env.API_TOKENS === undefined
      ? []
      : Object.entries(JSON.parse(env.API_TOKENS)),
  );
  const app = router<Env>({
    auth: bearer({
      verify: async ({ token }) => tokens.get(await hashApiKey(token)) ?? null,
    }),
  }).use(cors({
    origins: [env.SPA_ORIGIN],
    methods: ["GET", "PUT"],
    allowHeaders: ["authorization", "content-type"],
    maxAge: 3600,
  }));

  app.get("/api/status", { public: true }, (c) => c.json({ ok: true }));

  app.get("/api/profile", async (c) => {
    // The keyed identity of `key`: the scheme, issuer and subject together.
    const saved = await c.env.PROFILES.get<{ displayName: string }>(
      await opaqueIdentity(
        await identityKey,
        "router.profiles.owner",
        c.principal.key,
      ),
      "json",
    );
    return c.json({
      subject: c.principal.subject,
      displayName: saved?.displayName ?? null,
    });
  });

  app.put("/api/profile", {
    body: v.object({ displayName: v.string().trim().min(1).max(40) }),
  }, async (c) => {
    await c.env.PROFILES.put(
      await opaqueIdentity(
        await identityKey,
        "router.profiles.owner",
        c.principal.key,
      ),
      JSON.stringify(c.body),
    );
    return c.json({ subject: c.principal.subject, ...c.body });
  });

  return app;
}

let app: ReturnType<typeof build> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    app ??= build(env);
    return app.fetch(request, env, ctx);
  },
};
