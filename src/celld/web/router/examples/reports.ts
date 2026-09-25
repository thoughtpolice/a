// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An API behind JWT access tokens: `jwtBearer` with the issuer's JWK Set,
 * per-route scopes and a role.
 *
 * Tokens come from `https://auth.example.com` for the audience
 * `https://reports.example.com`, signed with ES256 and typed `at+jwt`
 * (RFC 9068). The key set is fetched from `JWKS_URI` on first use and
 * cached by `RemoteJwks`. A token for another audience, an expired one,
 * one signed by another key or with another algorithm (HS256, `none`) is
 * a 401 `invalid_token`; a token without a route's scope is a 403
 * `insufficient_scope` naming it.
 *
 * - `GET /health`: public.
 * - `GET /whoami`: any valid token.
 * - `GET /reports?cursor=` (`reports:read`): 100 reports at a time and the
 *   `cursor` of the next page, or null. `POST /reports` (`reports:write`,
 *   `{title, quarter}`).
 * - `GET /audit`: the `auditor` role.
 *
 * ```sh
 * buck2 run root//src/celld/web/router/examples:reports-dev
 * # the fake issuer's origin is printed; mint a token there:
 * curl -sS <issuer>/token -d '{"sub":"ada","scope":"reports:read"}'
 * curl -sS 127.0.0.1:9876/reports -H "authorization: Bearer $TOKEN"
 * ```
 *
 * @module
 */

import { RemoteJwks } from "@celld/sec/jwt";
import { jwtBearer, router } from "@celld/web/router";
import { opaqueIdentity } from "@celld/core/bounds";
import { v } from "@celld/sieve";

interface Env {
  /** Stable secret, at least 32 bytes; never use the example's development value. */
  readonly IDENTITY_SECRET: string;
  readonly JWKS_URI: string;
  readonly JWKS_LOOPBACK_FOR_DEVELOPMENT?: string;
  readonly REPORTS: KVNamespace;
}

const Report = v.object({
  title: v.string().trim().min(1).max(120),
  quarter: v.enum(["Q1", "Q2", "Q3", "Q4"]),
});

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
  const app = router<Env>({
    auth: jwtBearer({
      keys: new RemoteJwks(env.JWKS_URI, {
        allowLoopbackForDevelopment:
          env.JWKS_LOOPBACK_FOR_DEVELOPMENT === "true",
      }),
      issuer: "https://auth.example.com",
      audience: "https://reports.example.com",
      algorithms: ["ES256"],
      typ: "at+jwt",
      realm: "reports",
    }),
  });

  app.get("/health", { public: true }, (c) => c.json({ ok: true }));

  app.get("/whoami", (c) =>
    c.json({
      subject: c.principal.subject,
      scopes: c.principal.scopes,
      clientId: c.principal.clientId ?? null,
    }));

  app.get("/reports", {
    scopes: ["reports:read"],
    query: v.object({ cursor: v.string().max(1024).optional() }),
  }, async (c) => {
    const listed = await c.env.REPORTS.list({
      prefix: "report:",
      limit: 100,
      cursor: c.query.cursor,
    });
    const reports = await Promise.all(
      listed.keys.map((k) => c.env.REPORTS.get(k.name, "json")),
    );
    return c.json({
      reports,
      cursor: listed.list_complete ? null : listed.cursor,
    });
  });

  app.post(
    "/reports",
    { scopes: ["reports:write"], body: Report },
    async (c) => {
      const report = {
        id: c.requestId,
        ...c.body,
        // `author` is a label for people. Anything that later matches a
        // report to its caller compares `authorKey`, the keyed identity of the
        // principal's `key` (issuer and subject together), never the name.
        author: c.principal.subject,
        authorKey: await opaqueIdentity(
          await identityKey,
          "router.reports.author",
          c.principal.key,
        ),
      };
      await c.env.REPORTS.put(`report:${report.id}`, JSON.stringify(report));
      return c.json(report, 201);
    },
  );

  app.get(
    "/audit",
    { roles: ["auditor"] },
    (c) => c.json({ auditor: c.principal.subject, reports: "all of them" }),
  );

  return app;
}

let app: ReturnType<typeof build> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    app ??= build(env);
    return app.fetch(request, env, ctx);
  },
};
