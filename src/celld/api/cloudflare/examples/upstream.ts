// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The fake Cloudflare the cloudflare examples run against: `FakeCloudflare`
 * from `@celld/api/cloudflare/testing`, serving the v4 API and siteverify
 * from one origin. It starts with a zone, `example.com`, and a Turnstile
 * widget for it, and sets the variables the examples read:
 * `CLOUDFLARE_BASE_URL` (itself, with `CLOUDFLARE_LOOPBACK_FOR_DEVELOPMENT`,
 * since it serves http on loopback), `CLOUDFLARE_API_TOKEN` (the one token
 * it accepts), `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`,
 * `TURNSTILE_SITEKEY`, `TURNSTILE_SECRET`, and `TURNSTILE_SITEVERIFY_URL`
 * (with `TURNSTILE_LOOPBACK_FOR_DEVELOPMENT`).
 *
 * `POST /__turnstile/token` with `{"hostname", "action"}` plays the
 * visitor's browser: it answers `{"token"}`, as the widget would after a
 * solved challenge. A spec saves it and posts it to the Worker.
 *
 * `script` entries:
 *
 * - `{"fail": {"path": "/zones/...", "status": 502, "method": "POST"}}`
 *   fails the next matching API request (`pathSuffix` instead of `path`
 *   matches the end of the path, for paths with the fake's ids in them;
 *   `html: true` answers a proxy's page, `afterApplying: true` fails it
 *   after applying it, `errors` gives the envelope's errors);
 * - `{"domain": {...}}` sets what Intel knows about a domain;
 * - `{"maliciousUrl": "https://..."}` makes scans of that URL malicious;
 * - `{"scanPolls": 2}` makes new scans run for that many polls.
 *
 * @module
 */

import type { DomainIntel } from "@celld/api/cloudflare/investigate";
import {
  FakeCloudflare,
  type FakeFailure,
} from "@celld/api/cloudflare/testing";
import { serveUpstream } from "@celld/examples/upstream";

const TOKEN = "fake-api-token-for-the-examples";

const fake = new FakeCloudflare({ token: TOKEN });
const zone = fake.addZone("example.com");
const widget = fake.turnstile.addWidget({
  name: "signup",
  domains: ["example.com"],
  mode: "managed",
});

interface Instruction {
  readonly fail?: Omit<FakeFailure, "path"> & {
    readonly path?: string;
    readonly pathSuffix?: string;
  };
  readonly domain?: DomainIntel;
  readonly maliciousUrl?: string;
  readonly scanPolls?: number;
}

serveUpstream({
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__turnstile/token") {
      const body = await request.json() as {
        hostname?: string;
        action?: string;
      };
      const token = fake.turnstile.issueToken(widget.sitekey, {
        hostname: body.hostname ?? "example.com",
        action: body.action,
      });
      return Response.json({ token });
    }
    return await fake.handle(request);
  },
  script(instruction) {
    const step = instruction as Instruction;
    if (step.fail !== undefined) {
      const { pathSuffix, path, ...failure } = step.fail;
      fake.failNext({
        ...failure,
        path: pathSuffix === undefined
          ? path ?? ""
          : new RegExp(`${pathSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      });
    }
    if (step.domain !== undefined) fake.investigate.setDomain(step.domain);
    if (step.maliciousUrl !== undefined) {
      fake.investigate.maliciousUrls.add(step.maliciousUrl);
    }
    if (step.scanPolls !== undefined) {
      fake.investigate.scanPolls = step.scanPolls;
    }
  },
  vars: (origin) => ({
    CLOUDFLARE_BASE_URL: origin,
    CLOUDFLARE_LOOPBACK_FOR_DEVELOPMENT: "true",
    CLOUDFLARE_API_TOKEN: TOKEN,
    CLOUDFLARE_ACCOUNT_ID: fake.accountId,
    CLOUDFLARE_ZONE_ID: zone.id,
    TURNSTILE_SITEKEY: widget.sitekey,
    TURNSTILE_SECRET: fake.turnstile.widget(widget.sitekey)!.secret,
    TURNSTILE_SITEVERIFY_URL: `${origin}/turnstile/v0/siteverify`,
    TURNSTILE_LOOPBACK_FOR_DEVELOPMENT: "true",
  }),
});
