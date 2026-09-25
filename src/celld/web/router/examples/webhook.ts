// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A webhook receiver authenticated by API key, accepting deliveries only
 * from the sender's network, and each delivery only once.
 *
 * - The key comes in `X-Webhook-Key`. `WEBHOOK_KEYS` maps SHA-256 hashes
 *   of keys to principals, so the Worker holds no usable key; the sender's
 *   key has `hooks:deliver`, a dashboard's `hooks:read`. The spec's
 *   `vars` set `WEBHOOK_KEYS` for `celld dev` (public example keys);
 *   unset, every key is refused.
 * - The sender's address is `clientIpForAuthorization(c)`:
 *   `CF-Connecting-IP` is the peer, named explicitly with
 *   `clientIp.peerHeader` (without a named source the function is always
 *   null), and `X-Forwarded-For` is believed only
 *   when that peer is in `TRUSTED_PROXIES`; a chain that names no client
 *   (a trusted proxy that forwarded nothing) is null and refused. A
 *   delivery must come from `SENDER_CIDRS`, so a leaked key alone is not
 *   enough, and a spoofed `X-Forwarded-For` does not help. The peer header
 *   is trustworthy on Cloudflare's edge, which overwrites it; elsewhere
 *   (and under `celld dev`, where the spec sets it) give the router a
 *   `clientIp.peer` from the platform.
 * - Bodies are JSON (`{id, event, data}`), at most 16 KiB. Delivery is
 *   at least once, so each id's work runs to completion once. The
 *   `Delivery` Durable Object named by the id decides who runs it
 *   atomically: `claim` records the delivery as `claimed` with a lease
 *   (`LEASE_MS`) and the claimant's random lease token in one statement,
 *   and only the call that won runs the side effects, then marks it
 *   `done`. `finish` and `release` name the token, so a run that outlived
 *   its lease (whose claim another copy took over) cannot mark the new
 *   run's work done or delete its claim. A copy of a `done` delivery
 *   answers 200 `duplicate`; a copy arriving while it is `claimed` gets
 *   409 (retry later), because the work may still fail. When the side
 *   effects throw, the claim is released and the sender's retry runs
 *   them again; when the Worker dies mid-way, the lease runs out and the
 *   next copy takes the claim over. So the side effects must be
 *   idempotent (a crash between them and `done` repeats them). (A KV
 *   `get` then `put` could not claim at all: two copies racing through
 *   different places would both read "not seen" and both run.)
 * - A delivery's record is kept for seven days (`RETENTION_MS`), then the
 *   object's alarm deletes it; a copy of the delivery arriving after that
 *   would run again, so the window must outlast the sender's retries. With
 *   more than one sender, name the object by the sender's key hash and the
 *   id, so that one sender's ids cannot collide with another's.
 *
 * Routes: `POST /deliveries` (202), `GET /deliveries/:id`.
 *
 * ```sh
 * buck2 run root//src/celld/web/router/examples:webhook-dev
 * curl -sS 127.0.0.1:9876/deliveries -H 'x-webhook-key: whk_SHRO661LOs3XSd9Fz1fEhOTO2O2AmL4jhHg_8yMLGLM' \
 *   -H 'cf-connecting-ip: 192.0.2.10' -H 'content-type: application/json' \
 *   -d '{"id":"evt_1","event":"invoice.paid","data":{"amount":42}}'
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import { toCidr } from "@celld/core/ip";
import { opaqueIdentity } from "@celld/core/bounds";
import {
  apiKey,
  clientIpForAuthorization,
  hashedKeys,
  HttpError,
  router,
} from "@celld/web/router";
import { v } from "@celld/sieve";

interface Env {
  readonly IDENTITY_SECRET: string;
  /** `{"<sha256 of key>": {"subject": ..., "scopes": [...]}}` */
  readonly WEBHOOK_KEYS?: string;
  /** Comma-separated CIDR blocks the sender delivers from. */
  readonly SENDER_CIDRS: string;
  /** Comma-separated CIDR blocks of proxies in front of the Worker. */
  readonly TRUSTED_PROXIES: string;
  readonly DELIVERIES: DurableObjectNamespace<Delivery>;
}

/** How long a delivery's record, and so its duplicate check, is kept. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a claim holds before another copy may take it over: longer than
 * the side effects ever take, so a live run is never doubled.
 */
const LEASE_MS = 5 * 60 * 1000;

/** What a copy of a delivery should do. */
export type Claim = "run" | "running" | "done";

/** Statements of {@link Delivery}, one step each. */
const SQL = {
  create:
    "CREATE TABLE IF NOT EXISTS delivery (id TEXT PRIMARY KEY, record TEXT NOT NULL, state TEXT NOT NULL, lease_until INTEGER NOT NULL, lease TEXT NOT NULL)",
  insert:
    "INSERT OR IGNORE INTO delivery (id, record, state, lease_until, lease) VALUES (?, ?, 'claimed', ?, ?)",
  takeOver:
    "UPDATE delivery SET record = ?, lease_until = ?, lease = ? WHERE id = ? AND state = 'claimed' AND lease_until <= ?",
  state: "SELECT state FROM delivery WHERE id = ?",
  finish:
    "UPDATE delivery SET state = 'done' WHERE id = ? AND state = 'claimed' AND lease = ?",
  release:
    "DELETE FROM delivery WHERE id = ? AND state = 'claimed' AND lease = ?",
  forget: "DELETE FROM delivery",
  record: "SELECT record FROM delivery WHERE id = ?",
} as const;

/** One delivery id: whether it was received, and what was recorded. */
export class Delivery extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(SQL.create);
  }

  /**
   * Claims the delivery for this call, under `lease` (a random token the
   * caller keeps for `finish` or `release`): `run` when it is new or its
   * last claim's lease ran out (a run that died, or outlived it), `running`
   * while another call holds a live claim, `done` once its work finished.
   * Each step is one statement, so of concurrent calls exactly one gets
   * `run`. A new delivery also sets the alarm that deletes the record after
   * `RETENTION_MS`.
   */
  async claim(id: string, record: string, lease: string): Promise<Claim> {
    const now = Date.now();
    const { rowsWritten } = this.ctx.storage.sql.exec(
      SQL.insert,
      id,
      record,
      now + LEASE_MS,
      lease,
    );
    if (rowsWritten === 1) {
      await this.ctx.storage.setAlarm(now + RETENTION_MS);
      return "run";
    }
    const taken = this.ctx.storage.sql.exec(
      SQL.takeOver,
      record,
      now + LEASE_MS,
      lease,
      id,
      now,
    );
    if (taken.rowsWritten === 1) return "run";
    const rows = this.ctx.storage.sql.exec<{ state: string }>(SQL.state, id)
      .toArray();
    return rows[0]?.state === "done" ? "done" : "running";
  }

  /**
   * The work claimed under `lease` finished: later copies are duplicates.
   * False when that claim is no longer this lease's (another copy took it
   * over after the lease ran out), which changes nothing.
   */
  async finish(id: string, lease: string): Promise<boolean> {
    const { rowsWritten } = this.ctx.storage.sql.exec(SQL.finish, id, lease);
    return await Promise.resolve(rowsWritten === 1);
  }

  /**
   * The work claimed under `lease` failed: forget the claim, so a retry
   * runs it again. A claim another copy has taken over is left alone.
   */
  async release(id: string, lease: string): Promise<void> {
    this.ctx.storage.sql.exec(SQL.release, id, lease);
    await Promise.resolve();
  }

  /** Retention is over: forget the delivery. */
  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec(SQL.forget);
    await Promise.resolve();
  }

  /** The recorded delivery, or null. */
  async record(id: string): Promise<string | null> {
    const rows = this.ctx.storage.sql.exec<{ record: string }>(SQL.record, id)
      .toArray();
    return await Promise.resolve(rows[0]?.record ?? null);
  }
}

/**
 * A delivery's side effects, once its claim is won. They must be
 * idempotent: a run that dies after them but before `finish` is repeated
 * when its lease runs out.
 */
async function deliver(
  _env: Env,
  _delivery: { readonly id: string; readonly event: string },
): Promise<void> {
  await Promise.resolve();
}

const list = (text: string) =>
  text.split(",").map((s) => s.trim()).filter((s) => s !== "");

const DeliveryId = v.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const DeliveryBody = v.object({
  id: DeliveryId,
  event: v.enum(["invoice.paid", "invoice.voided", "customer.deleted"]),
  data: v.record(v.string(), v.unknown()),
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
  const senders = list(env.SENDER_CIDRS).map(toCidr);
  const app = router<Env>({
    auth: apiKey({
      header: "x-webhook-key",
      lookup: hashedKeys(
        env.WEBHOOK_KEYS === undefined ? {} : JSON.parse(env.WEBHOOK_KEYS),
      ),
    }),
    clientIp: {
      peerHeader: "cf-connecting-ip",
      trustedProxies: list(env.TRUSTED_PROXIES),
    },
    limits: { body: 16 * 1024 },
  });

  app.post("/deliveries", {
    scopes: ["hooks:deliver"],
    authorize: (_principal, c) => {
      const ip = clientIpForAuthorization(c);
      return ip !== null && senders.some((block) => block.contains(ip));
    },
    body: DeliveryBody,
  }, async (c) => {
    const record = {
      ...c.body,
      from: clientIpForAuthorization(c)!.toString(),
      // `sender` is a label; `senderKey` (the keyed identity of the principal's
      // `key`) is what to compare when a record is matched to a caller.
      sender: c.principal.subject,
      senderKey: await opaqueIdentity(
        await identityKey,
        "router.webhook.sender",
        c.principal.key,
      ),
    };
    const delivery = c.env.DELIVERIES.getByName(c.body.id);
    const lease = crypto.randomUUID();
    const claim = await delivery.claim(
      c.body.id,
      JSON.stringify(record),
      lease,
    );
    if (claim === "done") return c.json({ duplicate: true, id: c.body.id });
    if (claim === "running") {
      throw new HttpError(409, "this delivery is being processed; retry later");
    }
    try {
      await deliver(c.env, c.body);
    } catch (error) {
      // Not done: let the sender's retry run it again.
      await delivery.release(c.body.id, lease);
      throw error;
    }
    if (!await delivery.finish(c.body.id, lease)) {
      // This run outlived its lease and another copy took the claim over:
      // that run decides the outcome, so this copy may be retried.
      throw new HttpError(409, "this delivery is being processed; retry later");
    }
    return c.json({ accepted: true, id: c.body.id }, 202);
  });

  app.get("/deliveries/:id", {
    scopes: ["hooks:read"],
    params: v.object({ id: DeliveryId }),
  }, async (c) => {
    const found = await c.env.DELIVERIES.getByName(c.params.id).record(
      c.params.id,
    );
    if (found === null) throw new HttpError(404, "no such delivery");
    return c.json(JSON.parse(found));
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
