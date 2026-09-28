// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An operator's API over one zone: tunnels, the cache, and Investigate.
 *
 * - `POST /hostnames` with `{"hostname", "service"}` serves the hostname
 *   from the `web` tunnel (created on first use): its ingress rule, then a
 *   proxied CNAME to the tunnel. Publishing a hostname again replaces its
 *   rule and record, so a retried request changes nothing more.
 *   `GET /tunnel/token` hands out the token `cloudflared` runs with.
 * - `POST /purge` with `{"urls"}` purges those URLs from the cache.
 * - `GET /domains/:domain` is what Intel knows about a domain; `POST
 *   /scans` with `{"url"}` submits an unlisted URL Scanner scan and `GET
 *   /scans/:id` answers 202 until it has a verdict.
 *
 * Every route needs the operator's key in `x-api-key`: a random key of at
 * least 128 bits, such as `op_$(openssl rand -hex 16)`, whose SHA-256 is
 * the secret `ADMIN_KEY_SHA256` (the spec sets it in its `vars`). With that
 * unset or malformed, every request is a 401. The Cloudflare token comes
 * from `CLOUDFLARE_API_TOKEN`, or from the exe.dev integration when none
 * is bound; it needs Cloudflare Tunnel and DNS edit on the account and
 * zone, Cache Purge, Intel read and URL Scanner edit. Cloudflare's own
 * errors come back as a 502 with their codes; bodies over 16 KiB are a
 * 413.
 *
 * ```sh
 * buck2 run root//src/celld/api/cloudflare/examples:admin-dev
 * curl -sS -X POST localhost:9876/hostnames -H 'content-type: application/json' \
 *   -H 'x-api-key: op_4e4f4f2dd1b5f6e5e1b1a3b76f0cfc54' \
 *   -d '{"hostname": "app.example.com", "service": "http://localhost:8080"}'
 * ```
 *
 * @module
 */

import {
  CloudflareClient,
  type CloudflareEnv,
  CloudflareError,
} from "@celld/api/cloudflare";
import { Cache } from "@celld/api/cloudflare/cache";
import { Intel, UrlScanner } from "@celld/api/cloudflare/investigate";
import { Tunnels } from "@celld/api/cloudflare/tunnels";
import { apiKey, hashApiKey, router, timingSafeEqual } from "@celld/web/router";
import { v } from "@celld/sieve";

interface Env extends CloudflareEnv {
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly CLOUDFLARE_ZONE_ID: string;
  /** Hex SHA-256 of the operator's key. A secret. */
  readonly ADMIN_KEY_SHA256?: string;
}

const TUNNEL = "web";

/** Whether `key` hashes to the configured operator hash. Fails closed. */
async function isOperator(env: Env, key: string): Promise<boolean> {
  const want = env.ADMIN_KEY_SHA256?.trim().toLowerCase();
  if (want === undefined || !/^[0-9a-f]{64}$/.test(want)) return false;
  return timingSafeEqual(await hashApiKey(key), want);
}

const Hostname = v.strictObject({
  hostname: v.string().max(253),
  service: v.string().max(512),
});

const Purge = v.strictObject({
  urls: v.array(v.string().url().max(2048)).min(1).max(1000),
});

const Scan = v.strictObject({ url: v.string().url().max(2048) });

const app = router<Env>({
  auth: apiKey({
    realm: "operator",
    lookup: async (key, c) =>
      await isOperator(c.env, key) ? { subject: "operator" } : null,
  }),
  limits: { body: 16 * 1024 },
  // Bad input the library refused (a hostname, an id) is the caller's; a
  // Cloudflare refusal is a 502 with its codes, its text in the log.
  mapError: (error, c) => {
    if (error instanceof TypeError || error instanceof RangeError) {
      return c.json({ error: "bad_request", message: error.message }, 400);
    }
    if (error instanceof CloudflareError) {
      console.error("cloudflare:", error.message);
      return c.json({
        error: "cloudflare",
        status: error.status ?? null,
        codes: error.errors.map((item) => item.code),
      }, error.status === 404 ? 404 : 502);
    }
    return null;
  },
});

function cloudflare(env: Env): CloudflareClient {
  return CloudflareClient.fromEnv(env);
}

/** The `web` tunnel, made on first use. */
async function tunnel(env: Env) {
  const tunnels = new Tunnels(cloudflare(env), env.CLOUDFLARE_ACCOUNT_ID);
  const found = await tunnels.byName(TUNNEL);
  return { tunnels, tunnel: found ?? await tunnels.create({ name: TUNNEL }) };
}

app.post("/hostnames", { body: Hostname }, async (c) => {
  const { tunnels, tunnel: web } = await tunnel(c.env);
  const { record } = await tunnels.publish(web.id, {
    hostname: c.body.hostname,
    service: c.body.service,
    zoneId: c.env.CLOUDFLARE_ZONE_ID,
  });
  return c.json({
    tunnel: web.id,
    hostname: record.name,
    target: record.content,
  });
});

app.get("/tunnel/token", async (c) => {
  const { tunnels, tunnel: web } = await tunnel(c.env);
  return c.json({ tunnel: web.id, token: await tunnels.token(web.id) });
});

app.post("/purge", { body: Purge }, async (c) => {
  const cache = new Cache(cloudflare(c.env), c.env.CLOUDFLARE_ZONE_ID);
  const requests = await cache.purge({ files: c.body.urls });
  return c.json({ purged: c.body.urls.length, requests: requests.length });
});

app.get("/domains/:domain", async (c) => {
  const intel = new Intel(cloudflare(c.env), c.env.CLOUDFLARE_ACCOUNT_ID);
  const found = await intel.domain(c.params.domain);
  return c.json({
    domain: found.domain,
    risks: (found.risk_types ?? []).map((risk) => risk.name),
    categories: (found.content_categories ?? []).map((category) =>
      category.name
    ),
    rank: found.popularity_rank ?? null,
  });
});

app.post("/scans", { body: Scan }, async (c) => {
  const scanner = new UrlScanner(
    cloudflare(c.env),
    c.env.CLOUDFLARE_ACCOUNT_ID,
  );
  const scan = await scanner.submit({ url: c.body.url });
  return c.json({ id: scan.uuid }, 202);
});

app.get("/scans/:id", async (c) => {
  const scanner = new UrlScanner(
    cloudflare(c.env),
    c.env.CLOUDFLARE_ACCOUNT_ID,
  );
  const result = await scanner.result(c.params.id);
  if (result === null) return c.json({ status: "running" }, 202);
  return c.json({
    status: "done",
    malicious: result.verdicts?.overall?.malicious ?? false,
    page: result.page?.url ?? null,
  });
});

export default { fetch: app.fetch };
