// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link CookieSealer}: small JSON values sealed into cookie values with
 * AES-256-GCM, so a relying party can keep a pending login (with its PKCE
 * verifier and nonce) or a session in the browser without a store, and
 * the browser can neither read nor change it.
 *
 * A sealed value is `v1.<iv>.<ciphertext>` in base64url. The cookie's
 * name and an expiry are bound in: the name is the associated data, so a
 * value moved to another cookie does not open, and the expiry (epoch
 * seconds) is inside the ciphertext, so an old value stops opening even if
 * the browser keeps it. The key is derived from the secret with HKDF, so
 * one secret serves every cookie.
 *
 * @module
 */

import { type Clock, OAuthError } from "@celld/sec/oauth";
import { fromBase64Url, toBase64Url } from "@celld/sec/jwt";
import {
  jsonSnapshot,
  parseJsonBounded,
  safeInt,
  strictRecord,
} from "@celld/core/bounds";
import {
  defaultClock,
  epochSeconds,
  rotationSecrets,
  secretBytes,
} from "../util.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Internal browser transaction budget: four 3.8 KiB cookies per flow. */
export function checkPendingCookies(request: Request, prefix: string): void {
  const header = request.headers.get("cookie") ?? "";
  if (header.length > 16384) {
    throw new OAuthError("state_mismatch", "browser cookie budget exceeded");
  }
  const count =
    header.split(";").filter((entry) => entry.trim().startsWith(`${prefix}.`))
      .length;
  if (count >= 4) {
    throw new OAuthError(
      "state_mismatch",
      "too many pending logins; finish one or wait for expiry",
    );
  }
}

/** Internal state-specific authenticated cookie name, without exposing state. */
export async function transactionCookieName(
  prefix: string,
  state: string,
): Promise<string> {
  if (typeof state !== "string" || state.length === 0 || state.length > 256) {
    throw new OAuthError("state_mismatch", "missing or invalid login state");
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(state)),
  );
  return `${prefix}.${
    Array.from(
      digest.slice(0, 12),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")
  }`;
}

/** Options for {@link CookieSealer.create}. */
export interface CookieSealerOptions {
  /**
   * 32 random bytes (base64url) or more, kept as a secret; the same in
   * every isolate that must open the values. Shorter, or with fewer than
   * `SECRET_MIN_DISTINCT_BYTES` distinct bytes, is a `TypeError`.
   */
  readonly secret: string | Uint8Array;
  /** Older secrets that still open values (not used to seal), newest first. */
  readonly previous?: readonly (string | Uint8Array)[];
  readonly now?: Clock;
}

async function deriveKey(secret: string | Uint8Array): Promise<CryptoKey> {
  const bytes = secretBytes(secret, "a cookie secret");
  const base = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(bytes),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode("@celld/sec/oidc cookie v1"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seals and opens cookie values; see the module documentation. */
export class CookieSealer {
  readonly #keys: readonly CryptoKey[];
  readonly #now: Clock;

  private constructor(keys: readonly CryptoKey[], now: Clock) {
    this.#keys = keys;
    this.#now = now;
  }

  /** A sealer; throws `TypeError` for a secret shorter than 32 bytes or plainly not random. */
  static async create(options: CookieSealerOptions): Promise<CookieSealer> {
    strictRecord(
      options,
      ["secret", "previous", "now"],
      "CookieSealer options",
    );
    const secrets = rotationSecrets(
      options.secret,
      options.previous,
      "cookie secret",
    );
    const now = options.now ?? defaultClock;
    if (typeof now !== "function") throw new TypeError("now must be a clock");
    epochSeconds(now);
    return new CookieSealer(
      Object.freeze(await Promise.all(secrets.map(deriveKey))),
      now,
    );
  }

  /** `value` sealed for the cookie `name`, opening for `maxAgeSec` seconds. */
  async seal(name: string, value: unknown, maxAgeSec: number): Promise<string> {
    setCookie(name, "");
    safeInt(maxAgeSec, { name: "maxAgeSec", min: 1, max: 30 * 86400 });
    value = jsonSnapshot(value, {
      maxDepth: 16,
      maxItems: 256,
      maxBytes: 2700,
    });
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = encoder.encode(
      JSON.stringify({ e: epochSeconds(this.#now) + maxAgeSec, v: value }),
    );
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
        this.#keys[0],
        plain,
      ),
    );
    const output = `v1.${toBase64Url(iv)}.${toBase64Url(sealed)}`;
    if (output.length > 3800) {
      throw new RangeError("sealed cookie exceeds browser budget");
    }
    return output;
  }

  /** The value sealed for the cookie `name`, or null when it is forged, moved, expired or malformed. */
  async unseal<T>(
    name: string,
    text: string | null | undefined,
  ): Promise<T | null> {
    if (typeof text !== "string" || text.length > 3800 || name.length > 128) {
      return null;
    }
    const parts = text.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return null;
    const iv = fromBase64Url(parts[1]);
    const data = fromBase64Url(parts[2]);
    if (iv === null || data === null || iv.length !== 12) return null;
    for (const key of this.#keys) {
      let plain: Uint8Array;
      try {
        plain = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
            key,
            data,
          ),
        );
      } catch {
        continue;
      }
      try {
        const opened = parseJsonBounded(decoder.decode(plain), {
          maxDepth: 16,
          maxKeys: 128,
          maxItems: 256,
          maxBytes: 2800,
        }) as {
          e?: unknown;
          v?: unknown;
        };
        if (
          typeof opened.e !== "number" || !Number.isFinite(opened.e) ||
          opened.e <= epochSeconds(this.#now)
        ) {
          return null;
        }
        return opened.v as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Cookie attributes for {@link setCookie}. */
export interface CookieOptions {
  readonly maxAgeSec?: number;
  readonly path?: string;
  /** Default `Lax`, which a login callback needs (it is a top-level cross-site GET). */
  readonly sameSite?: "Strict" | "Lax" | "None";
  /** Default true; turn off only for `http:` on loopback, where browsers drop `Secure` cookies from http. */
  readonly secure?: boolean;
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

/** A `Set-Cookie` value: `HttpOnly`, `Secure` unless told otherwise, `SameSite=Lax`, `Path=/`. */
export function setCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  strictRecord(
    options as unknown,
    ["maxAgeSec", "path", "sameSite", "secure"],
    "cookie options",
  );
  if (
    typeof name !== "string" || name.length > 128 || !COOKIE_NAME.test(name)
  ) throw new TypeError("bad cookie name");
  if (
    typeof value !== "string" || value.length > 3800 ||
    !COOKIE_VALUE.test(value)
  ) throw new TypeError("bad cookie value");
  const path = options.path === undefined ? "/" : options.path;
  const secure = options.secure === undefined ? true : options.secure;
  const sameSite = options.sameSite === undefined ? "Lax" : options.sameSite;
  if (
    typeof secure !== "boolean" ||
    !["Strict", "Lax", "None"].includes(sameSite) || typeof path !== "string" ||
    path.length > 1024 || !path.startsWith("/") || path.includes(";") ||
    [...path].some((char) =>
      char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127
    )
  ) throw new TypeError("invalid cookie attributes");
  if (
    (name.startsWith("__Host-") && (!secure || path !== "/")) ||
    (name.startsWith("__Secure-") && !secure) ||
    (sameSite === "None" && !secure)
  ) {
    throw new TypeError(
      "cookie prefix/SameSite requires Secure and the correct path",
    );
  }
  const parts = [`${name}=${value}`, `Path=${options.path ?? "/"}`];
  if (options.maxAgeSec !== undefined) {
    safeInt(options.maxAgeSec, { name: "maxAgeSec", min: 0, max: 30 * 86400 });
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSec))}`);
  }
  if (options.secure ?? true) parts.push("Secure");
  parts.push("HttpOnly", `SameSite=${options.sameSite ?? "Lax"}`);
  const output = parts.join("; ");
  if (output.length > 4096) {
    throw new RangeError("cookie exceeds browser budget");
  }
  return output;
}

/** A `Set-Cookie` value that deletes the cookie. */
export function clearCookie(name: string, options: CookieOptions = {}): string {
  return setCookie(name, "", { ...options, maxAgeSec: 0 });
}

/** The value of cookie `name` in a `Cookie` header, or null. */
export function readCookie(header: string | null, name: string): string | null {
  if (header === null || header.length > 16384) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      if (found !== null) return null;
      found = part.slice(index + 1).trim();
    }
  }
  return found;
}
