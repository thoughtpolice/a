// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A webhook receiver authenticated by API key, accepting deliveries only
 * from the sender's network, and each delivery only once.
 *
 * - The key comes in `X-Webhook-Key`. `WEBHOOK_KEYS` maps SHA-256 hashes
 *   of keys to principals, so the Worker holds no usable key; the sender's
 *   key has `hooks:deliver`, a dashboard's `hooks:read`.
 * - The client address is `c.ip()`: `CF-Connecting-IP` is the peer, and
 *   `X-Forwarded-For` is believed only when that peer is in
 *   `TRUSTED_PROXIES`. A delivery must come from `SENDER_CIDRS`, so a
 *   leaked key alone is not enough, and a spoofed `X-Forwarded-For` does
 *   not help.
 * - Bodies are JSON (`{id, event, data}`), at most 16 KiB. A delivery id
 *   already seen answers 200 `duplicate` instead of running twice.
 *
 * Routes: `POST /deliveries` (202), `GET /deliveries/:id`.
 *
 * ```sh
 * buck2 run root//src/celld/router/examples:webhook-dev
 * curl -sS localhost:9876/deliveries -H 'x-webhook-key: whk_live_4f7a2c9e1b8d6a30' \
 *   -H 'cf-connecting-ip: 192.0.2.10' -H 'content-type: application/json' \
 *   -d '{"id":"evt_1","event":"invoice.paid","data":{"amount":42}}'
 * ```
 *
 * @module
 */

import { toCidr } from "@celld/ip";
import { apiKey, hashedKeys, HttpError, router } from "@celld/router";
import { v } from "@celld/sieve";

interface Env {
  /** `{"<sha256 of key>": {"subject": ..., "scopes": [...]}}` */
  readonly WEBHOOK_KEYS: string;
  /** Comma-separated CIDR blocks the sender delivers from. */
  readonly SENDER_CIDRS: string;
  /** Comma-separated CIDR blocks of proxies in front of the Worker. */
  readonly TRUSTED_PROXIES: string;
  readonly DELIVERIES: KVNamespace;
}

const list = (text: string) =>
  text.split(",").map((s) => s.trim()).filter((s) => s !== "");

const Delivery = v.object({
  id: v.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  event: v.enum(["invoice.paid", "invoice.voided", "customer.deleted"]),
  data: v.record(v.string(), v.unknown()),
});

function build(env: Env) {
  const senders = list(env.SENDER_CIDRS).map(toCidr);
  const app = router<Env>({
    auth: apiKey({
      header: "x-webhook-key",
      lookup: hashedKeys(JSON.parse(env.WEBHOOK_KEYS)),
    }),
    clientIp: { trustedProxies: list(env.TRUSTED_PROXIES) },
    limits: { body: 16 * 1024 },
  });

  app.post("/deliveries", {
    scopes: ["hooks:deliver"],
    authorize: (_principal, c) => {
      const ip = c.ip();
      return ip !== null && senders.some((block) => block.contains(ip));
    },
    body: Delivery,
  }, async (c) => {
    const key = `delivery:${c.body.id}`;
    if (await c.env.DELIVERIES.get(key) !== null) {
      return c.json({ duplicate: true, id: c.body.id });
    }
    const record = {
      ...c.body,
      from: c.ip()!.toString(),
      sender: c.principal.subject,
    };
    await c.env.DELIVERIES.put(key, JSON.stringify(record));
    return c.json({ accepted: true, id: c.body.id }, 202);
  });

  app.get("/deliveries/:id", { scopes: ["hooks:read"] }, async (c) => {
    const found = await c.env.DELIVERIES.get(`delivery:${c.params.id}`, "json");
    if (found === null) throw new HttpError(404, "no such delivery");
    return c.json(found);
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
