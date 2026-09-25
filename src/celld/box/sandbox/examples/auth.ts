// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Who is calling, for the `runner` and `jobs` examples: a bearer token
 * `<subject>.<unix-expiry>.<mac>`, where `mac` is the base64url HMAC-SHA256 of
 * `"subject-exp:" + subject + ":" + unixExpiry` under `AUTH_SECRET`.
 * Expiry is required and must be at most one hour in the future. Whoever holds the secret (a
 * login service, say) mints tokens; the Worker only verifies them.
 *
 * The sandbox a caller gets is named by a domain-separated keyed hash of a
 * canonical fixed-scheme identity tuple containing the verified subject,
 * using the sandbox library's `deriveSandboxId`. A caller cannot pick another
 * caller's sandbox, and sandbox names say nothing about subjects.
 *
 * The specs (`runner.json`, `jobs.json`) set a development secret in their
 * `vars`; a deployment sets its own, at least 32 characters, as a secret
 * and keeps it out of the source. Without one, `authenticate` throws.
 *
 * Legacy non-expiring `<subject>.<mac>` tokens exist ONLY for the reproducible
 * local specs, behind `UNSAFE_DEMO_AUTH=1`. This helper is example code, not a
 * production authentication protocol. A real service should use short-lived
 * JWT/OIDC credentials with issuer, audience and expiry validation (`@celld/sec/jwt`).
 */

import { deriveSandboxId } from "@celld/box/sandbox";

const encoder = new TextEncoder();
const SUBJECT = /^[A-Za-z0-9_@.-]{1,128}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;

/** A caller whose token verified. */
export interface Caller {
  readonly subject: string;
  /** The sandbox id for this caller: a keyed hash of its canonical identity. */
  readonly tenant: string;
}

async function key(secret: string | undefined): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("AUTH_SECRET must be set to at least 32 characters");
  }
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=";
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/**
 * The caller of `request`, or null when it carries no valid token. The
 * MAC is checked with `crypto.subtle.verify`, in constant time.
 */
export async function authenticate(
  request: Request,
  secret: string | undefined,
  unsafeDemoTokens = false,
): Promise<Caller | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]{1,256})$/.exec(header);
  if (match === null) return null;
  const token = match[1];
  const dot = token.lastIndexOf(".");
  const identity = token.slice(0, dot);
  const expiryAt = identity.lastIndexOf(".");
  const expires = expiryAt < 0 ? NaN : Number(identity.slice(expiryAt + 1));
  const expiring = expiryAt > 0 &&
    /^[0-9]{10}$/.test(identity.slice(expiryAt + 1));
  const subject = expiring ? identity.slice(0, expiryAt) : identity;
  const mac = token.slice(dot + 1);
  const now = Math.floor(Date.now() / 1000);
  if (
    expiring
      ? expires <= now || expires > now + 3600
      : unsafeDemoTokens !== true
  ) return null;
  if (dot < 1 || !SUBJECT.test(subject) || !MAC.test(mac)) return null;
  const hmac = await key(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    hmac,
    fromBase64Url(mac),
    encoder.encode(
      expiring ? `subject-exp:${subject}:${expires}` : `subject:${subject}`,
    ),
  );
  if (!valid) return null;
  const tenant = await deriveSandboxId(
    hmac,
    "sandbox-examples",
    JSON.stringify(["demo-hmac", "sandbox-examples", subject]),
  );
  return { subject, tenant };
}

/** The answer to a request without a valid token. */
export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, {
    status: 401,
    headers: { "www-authenticate": 'Bearer realm="sandbox"' },
  });
}
