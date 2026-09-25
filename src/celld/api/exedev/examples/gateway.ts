// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An app behind exe.dev's HTTPS proxy that calls an HTTP proxy integration.
 *
 * On a VM, `https://<vm>.exe.xyz` reaches the app through exe.dev's proxy,
 * which strips and sets identity headers. `exeAuth()` is the
 * `@celld/router` scheme that reads them: every route needs a logged-in
 * user unless it is public, an anonymous browser is sent to the proxy's
 * login page with a 302, and any other anonymous client gets a 401. Those
 * headers are only trustworthy for requests that came through the proxy;
 * in local development `devIdentityHeaders` stands in for it.
 *
 * - `GET /health` is public.
 * - `GET /me` returns who is calling.
 * - `GET /forecast?city=...` calls the `weather` integration, an `http-proxy`
 *   integration whose credential exe.dev injects at its edge, so the app
 *   holds no key. `VmIntegrations.fetch` reaches it at
 *   `https://weather.int.exe.xyz`; the caller's email goes along as
 *   `x-on-behalf-of`, and the integration's answer comes back unchanged.
 *
 * `EXE_INTEGRATION_DOMAIN` and `EXE_INTEGRATION_SCHEME` replace `int.exe.xyz`
 * and `https`; the fake upstream sets them to itself on `*.localhost`.
 *
 * ```sh
 * buck2 run root//src/celld/api/exedev/examples:gateway-dev
 * curl -sS localhost:9876/me -H 'X-ExeDev-UserID: u1' -H 'X-ExeDev-Email: me@example.com'
 * curl -sS 'localhost:9876/forecast?city=Austin' -H 'X-ExeDev-UserID: u1' ...
 * ```
 *
 * @module
 */

import { exeAuth } from "@celld/api/exedev/proxy";
import { VmIntegrations } from "@celld/api/exedev/vm";
import { router } from "@celld/router";
import { v } from "@celld/sieve";

interface Env {
  readonly EXE_INTEGRATION_DOMAIN?: string;
  readonly EXE_INTEGRATION_SCHEME?: "http" | "https";
}

const app = router<Env>({ auth: exeAuth() });

app.get("/health", { public: true }, (c) => c.json({ ok: true }));

app.get("/me", (c) =>
  c.json({
    userId: c.principal.subject,
    email: c.principal.claims.email,
    tokenCtx: c.principal.claims.tokenCtx ?? null,
    via: c.req.headers.get("x-forwarded-host"),
  }));

app.get("/forecast", {
  query: v.object({ city: v.string().min(1).max(100) }),
}, async (c) => {
  const integrations = new VmIntegrations({
    domain: c.env.EXE_INTEGRATION_DOMAIN,
    scheme: c.env.EXE_INTEGRATION_SCHEME,
  });
  const email = c.principal.claims.email;
  const answer = await integrations.fetch(
    "weather",
    `/v1/forecast?${new URLSearchParams({ city: c.query.city })}`,
    {
      headers: {
        "x-on-behalf-of": typeof email === "string" ? email : "unknown",
      },
    },
  );
  return new Response(answer.body, {
    status: answer.status,
    headers: { "content-type": "application/json" },
  });
});

export default { fetch: app.fetch };
