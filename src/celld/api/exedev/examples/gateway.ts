// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An app behind exe.dev's HTTPS proxy that calls an HTTP proxy integration.
 *
 * On a VM, `https://<vm>.exe.xyz` reaches the app through exe.dev's proxy,
 * which strips and sets identity headers. `exeAuth()` is the
 * `@celld/web/router` scheme that reads them: every route needs a logged-in
 * user unless it is public, an anonymous browser is sent to the proxy's
 * login page with a 302, and any other anonymous client gets a 401. Those
 * headers are only trustworthy for requests that came through the proxy,
 * so `exeAuth` needs a `trust` rule: `EXE_PROXY_PEERS` lists the proxy's
 * address blocks (the peer is read from `CF-Connecting-IP`, which is right
 * only where the platform sets that header and clients cannot; elsewhere
 * give the router's `clientIp.peer` from the platform), and
 * `EXE_PUBLIC_ORIGIN` is the app's `https://<vm>.exe.xyz`. In local
 * development `EXE_ANY_PEER_FOR_DEVELOPMENT=true` trusts every peer over
 * plain http, and `devIdentityHeaders` stands in for the proxy. With
 * neither set, the Worker refuses to start.
 *
 * - `GET /health` is public.
 * - `GET /me` returns who is calling.
 * - `GET /forecast?city=...` calls the `weather` integration, an `http-proxy`
 *   integration whose credential exe.dev injects at its edge, so the app
 *   holds no key. `VmIntegrations.fetch` reaches it at
 *   `https://weather.int.exe.xyz`; the caller's email goes along as
 *   `x-on-behalf-of`, and the integration's answer comes back unchanged,
 *   streamed rather than buffered. That fetch is a raw proxy, which the
 *   caller bounds: a redirect is refused (502 `integration_redirect`,
 *   never followed with the caller's identity header), and an answer that
 *   takes more than 5 seconds, body included, is a 504
 *   `integration_timeout`.
 *
 * `EXE_INTEGRATION_DOMAIN` replaces `int.exe.xyz`, and
 * `EXE_INTEGRATION_CLEARTEXT_FOR_DEVELOPMENT=true` switches integration
 * origins to plain http. With development trust and `EXE_BASE_URL`, the fake
 * transport connects to that upstream while preserving the integration Host;
 * it does not depend on the host resolver supporting `*.localhost`.
 *
 * ```sh
 * buck2 run root//src/celld/api/exedev/examples:gateway-dev
 * curl -sS localhost:9876/me -H 'X-ExeDev-UserID: u1' -H 'X-ExeDev-Email: me@example.com'
 * curl -sS 'localhost:9876/forecast?city=Austin' -H 'X-ExeDev-UserID: u1' ...
 * ```
 *
 * @module
 */

import { exeAuth, type ExeProxyTrust } from "@celld/api/exedev/proxy";
import { VmIntegrations } from "@celld/api/exedev/vm";
import { router } from "@celld/web/router";
import { v } from "@celld/sieve";

interface Env {
  readonly EXE_BASE_URL?: string;
  readonly EXE_INTEGRATION_DOMAIN?: string;
  readonly EXE_INTEGRATION_CLEARTEXT_FOR_DEVELOPMENT?: string;
  readonly EXE_PROXY_PEERS?: string;
  readonly EXE_PUBLIC_ORIGIN?: string;
  readonly EXE_ANY_PEER_FOR_DEVELOPMENT?: string;
}

/** How long the integration has to answer, body included. */
const FORECAST_TIMEOUT_MS = 5_000;

function build(env: Env) {
  const development = env.EXE_ANY_PEER_FOR_DEVELOPMENT === "true";
  let trust: ExeProxyTrust;
  if (env.EXE_PROXY_PEERS !== undefined) {
    trust = { peers: env.EXE_PROXY_PEERS.split(",").map((b) => b.trim()) };
  } else if (development) {
    trust = "unsafeAnyPeerForDevelopment";
  } else {
    throw new Error(
      "set EXE_PROXY_PEERS (and EXE_PUBLIC_ORIGIN), or EXE_ANY_PEER_FOR_DEVELOPMENT=true in development",
    );
  }
  const app = router<Env>({
    auth: exeAuth({ trust }),
    ...(env.EXE_PROXY_PEERS === undefined
      ? {}
      : { clientIp: { peerHeader: "cf-connecting-ip" } }),
    ...(env.EXE_PUBLIC_ORIGIN === undefined
      ? {}
      : { publicUrl: { mode: "fixed", origin: env.EXE_PUBLIC_ORIGIN } }),
    allowCleartextCredentialsForDevelopment: development,
  });

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
    const upstream = development &&
        c.env.EXE_INTEGRATION_CLEARTEXT_FOR_DEVELOPMENT === "true" &&
        c.env.EXE_BASE_URL !== undefined
      ? new URL(c.env.EXE_BASE_URL)
      : undefined;
    const integrations = new VmIntegrations({
      domain: c.env.EXE_INTEGRATION_DOMAIN,
      allowCleartextForDevelopment:
        c.env.EXE_INTEGRATION_CLEARTEXT_FOR_DEVELOPMENT === "true",
      fetch: upstream === undefined ? undefined : (input, init) => {
        const request = new Request(input, init);
        const target = new URL(request.url);
        request.headers.set("host", target.host);
        target.host = upstream.host;
        return fetch(target, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: request.signal,
          redirect: request.redirect,
        });
      },
    });
    const email = c.principal.claims.email;
    let answer: Response;
    try {
      answer = await integrations.fetch(
        "weather",
        `/v1/forecast?${new URLSearchParams({ city: c.query.city })}`,
        {
          headers: {
            "x-on-behalf-of": typeof email === "string" ? email : "unknown",
          },
          // The raw proxy is the caller's to bound. A redirect is refused: it
          // would take the caller's identity header to another URL. The
          // deadline covers the answer's body too, since the signal aborts
          // its stream.
          redirect: "manual",
          signal: AbortSignal.timeout(FORECAST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return c.json({ error: "integration_timeout" }, 504);
      }
      throw error;
    }
    if (answer.status >= 300 && answer.status < 400) {
      await answer.body?.cancel();
      return c.json({ error: "integration_redirect" }, 502);
    }
    return new Response(answer.body, {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  });
  return app;
}

let app: ReturnType<typeof build> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    app ??= build(env);
    return app.fetch(request, env, ctx);
  },
};
