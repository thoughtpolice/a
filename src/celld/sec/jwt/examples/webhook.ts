// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A webhook receiver for partners who sign each delivery with a JWT.
 *
 * Each partner shares an HS256 secret with us. The `PARTNER_SECRETS` secret
 * lists them as `name=<base64url>,...`, and the Worker makes one prepared
 * verifier per partner with `createVerifier` (its secret imported once,
 * its name the only accepted `iss`). A token's `kid` picks the partner's
 * verifier, so a token cannot choose another partner's key. (A JWKS of
 * `oct` keys would do the same, but celld's WebCrypto cannot import
 * HMAC keys from JWKs, only raw bytes.) A delivery is `POST /webhooks` with
 * `Authorization: Bearer <jwt>` and a JSON body, and is accepted (202) only
 * when:
 *
 * - it comes from an address in `ALLOWED_SOURCES` (CIDR blocks, checked
 *   with `@celld/core/ip`; the address is `CF-Connecting-IP`, which only
 *   Cloudflare's edge sets and overwrites: anywhere else, the spec's
 *   `celld dev` included, a client writes it, so the blocks are defence in
 *   depth and the signature is what authenticates);
 * - the token verifies: HS256, `iss` is the partner the `kid` names, `aud`
 *   is this endpoint, and `exp` and `jti` are present;
 * - its `body_sha256` claim is the base64url SHA-256 of the body, which
 *   binds the signature to this body and no other;
 * - its `jti` was not seen before, so a captured delivery cannot be
 *   replayed. The `Deliveries` Durable Object decides that atomically (KV,
 *   being eventually consistent, could let two copies racing through
 *   different places both pass) and keeps each `jti` until its token
 *   expires, purging once a day. Required `iat`, `maxLifetime: 300` and
 *   the durable object's independent 300-second expiry bound prevent a
 *   partner from requesting arbitrary replay-record retention.
 *
 * The body is read only after the token verifies, under a 16 KiB cap
 * (413 beyond it).
 *
 * Refusals are 401 with the `JwtError` code (or `body_mismatch`), 403 for a
 * source outside the allowed blocks, and 409 for a replay.
 *
 * ```sh
 * buck2 run root//src/celld/sec/jwt/examples:webhook-dev
 * curl -sS -X POST localhost:9876/webhooks -H 'cf-connecting-ip: 192.0.2.10' \
 *   -H "authorization: Bearer $TOKEN" -d '{"type": "invoice.paid"}'
 * ```
 *
 * @module
 */

import { BoundsError, bytes, readTextBounded } from "@celld/core/bounds";
import { DurableObject } from "cloudflare:workers";
import { parseIp, toCidr } from "@celld/core/ip";
import {
  createVerifier,
  fromBase64Url,
  type JwtClaims,
  JwtError,
  type JwtVerifier,
  toBase64Url,
  tryDecode,
} from "@celld/sec/jwt";

const DAY_MS = 86_400_000;

interface Env {
  readonly PARTNER_SECRETS: string;
  readonly ALLOWED_SOURCES: string;
  readonly AUDIENCE: string;
  readonly DELIVERIES: DurableObjectNamespace<Deliveries>;
}

interface Delivery {
  readonly iss: string;
  readonly jti: string;
  readonly exp: number;
  readonly body_sha256?: unknown;
}

/** The deliveries one partner has made, by `jti`, until they expire. */
export class Deliveries extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS seen (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL)",
    );
  }

  /** Records `jti`; false when it was already recorded. */
  async claim(jti: string, exp: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof jti !== "string" || jti.length === 0 || jti.length > 256 ||
      !Number.isSafeInteger(exp) || exp <= now || exp > now + 300
    ) throw new TypeError("invalid delivery replay record");
    const { rowsWritten } = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO seen (jti, exp) VALUES (?, ?)",
      jti,
      exp,
    );
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    }
    return rowsWritten > 0;
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec(
      "DELETE FROM seen WHERE exp < ?",
      Math.floor(Date.now() / 1000),
    );
    const left = this.ctx.storage.sql.exec<{ n: number }>(
      "SELECT count(*) AS n FROM seen",
    ).one().n;
    if (left > 0) await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
  }
}

function refuse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** The claims as a `Delivery`, or a throw (`invalid_claim`). */
function deliveryClaims(claims: JwtClaims): Delivery {
  const { iss, jti, exp, body_sha256 } = claims;
  if (
    typeof iss !== "string" || typeof jti !== "string" ||
    typeof exp !== "number" || jti.length === 0 || jti.length > 256 ||
    !Number.isFinite(exp)
  ) {
    throw new TypeError("not a delivery");
  }
  return { iss, jti, exp, body_sha256 };
}

let prepared:
  | { config: string; verifiers: Map<string, JwtVerifier<Delivery>> }
  | undefined;

/** One prepared verifier per partner, by `kid`; made once per isolate. */
function partnerVerifiers(env: Env): Map<string, JwtVerifier<Delivery>> {
  const config = JSON.stringify([env.PARTNER_SECRETS, env.AUDIENCE]);
  if (prepared?.config === config) return prepared.verifiers;
  const verifiers = new Map<string, JwtVerifier<Delivery>>();
  for (const entry of env.PARTNER_SECRETS.split(",")) {
    const [kid, text] = entry.trim().split("=");
    const secret = fromBase64Url(text ?? "");
    if (secret === null) {
      throw new Error(`partner ${kid}'s secret is not base64url`);
    }
    verifiers.set(
      kid,
      createVerifier({
        keys: secret,
        algorithms: ["HS256"],
        issuer: kid,
        audience: env.AUDIENCE,
        requiredClaims: ["exp", "jti", "body_sha256"],
        maxLifetime: 300,
        claims: deliveryClaims,
      }),
    );
  }
  prepared = { config, verifiers };
  return verifiers;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return toBase64Url(new Uint8Array(digest));
}

async function receive(request: Request, env: Env): Promise<Response> {
  const source = parseIp(request.headers.get("cf-connecting-ip") ?? "");
  const allowed = env.ALLOWED_SOURCES.split(",").map((block) =>
    toCidr(block.trim())
  );
  if (source === null || !allowed.some((block) => block.contains(source))) {
    return refuse(403, "source_not_allowed");
  }
  const token = /^Bearer (\S+)$/.exec(
    request.headers.get("authorization") ?? "",
  )
    ?.[1];
  if (token === undefined) return refuse(401, "no_token");
  // The kid names the partner; the signature check below is what proves it.
  const kid = tryDecode(token)?.header.kid;
  if (typeof kid !== "string") return refuse(401, "malformed");
  const verifier = partnerVerifiers(env).get(kid);
  if (verifier === undefined) return refuse(401, "no_key");
  let delivery: Delivery;
  try {
    ({ payload: delivery } = await verifier.verify(token));
  } catch (error) {
    if (error instanceof JwtError) return refuse(401, error.code);
    throw error;
  }
  let body: string;
  try {
    body = await readTextBounded(request, { maxBytes: bytes(16 * 1024) });
  } catch (error) {
    if (error instanceof BoundsError && error.code === "too_large") {
      return refuse(413, "too_large");
    }
    throw error;
  }
  if (delivery.body_sha256 !== await sha256(body)) {
    return refuse(401, "body_mismatch");
  }
  const first = await env.DELIVERIES.getByName(delivery.iss).claim(
    delivery.jti,
    delivery.exp,
  );
  if (!first) return refuse(409, "replayed");
  let event: { type?: unknown };
  try {
    event = JSON.parse(body);
  } catch {
    return refuse(400, "not_json");
  }
  return Response.json({
    accepted: delivery.jti,
    partner: delivery.iss,
    type: event.type ?? null,
  }, { status: 202 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/webhooks") {
      return await receive(request, env);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
