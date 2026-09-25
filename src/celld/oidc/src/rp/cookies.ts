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

import type { Clock } from "@celld/oauth";
import { fromBase64Url, toBase64Url } from "@celld/jwt";
import { defaultClock, epochSeconds } from "../util.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Options for {@link CookieSealer.create}. */
export interface CookieSealerOptions {
  /** At least 32 bytes; the same in every isolate that must open the values. */
  readonly secret: string | Uint8Array;
  /** Older secrets that still open values (not used to seal), newest first. */
  readonly previous?: readonly (string | Uint8Array)[];
  readonly now?: Clock;
}

async function deriveKey(secret: string | Uint8Array): Promise<CryptoKey> {
  const bytes = typeof secret === "string" ? encoder.encode(secret) : secret;
  if (bytes.length < 32) {
    throw new TypeError("a cookie secret needs at least 32 bytes");
  }
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
      info: encoder.encode("@celld/oidc cookie v1"),
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

  /** A sealer; throws `TypeError` for a secret shorter than 32 bytes. */
  static async create(options: CookieSealerOptions): Promise<CookieSealer> {
    const keys = [await deriveKey(options.secret)];
    for (const old of options.previous ?? []) keys.push(await deriveKey(old));
    return new CookieSealer(keys, options.now ?? defaultClock);
  }

  /** `value` sealed for the cookie `name`, opening for `maxAgeSec` seconds. */
  async seal(name: string, value: unknown, maxAgeSec: number): Promise<string> {
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
    return `v1.${toBase64Url(iv)}.${toBase64Url(sealed)}`;
  }

  /** The value sealed for the cookie `name`, or null when it is forged, moved, expired or malformed. */
  async unseal<T>(
    name: string,
    text: string | null | undefined,
  ): Promise<T | null> {
    if (typeof text !== "string") return null;
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
        const opened = JSON.parse(decoder.decode(plain)) as {
          e?: unknown;
          v?: unknown;
        };
        if (
          typeof opened.e !== "number" || opened.e <= epochSeconds(this.#now)
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
  if (!COOKIE_NAME.test(name)) throw new TypeError(`bad cookie name ${name}`);
  if (!COOKIE_VALUE.test(value)) throw new TypeError("bad cookie value");
  const parts = [`${name}=${value}`, `Path=${options.path ?? "/"}`];
  if (options.maxAgeSec !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSec))}`);
  }
  if (options.secure ?? true) parts.push("Secure");
  parts.push("HttpOnly", `SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

/** A `Set-Cookie` value that deletes the cookie. */
export function clearCookie(name: string, options: CookieOptions = {}): string {
  return setCookie(name, "", { ...options, maxAgeSec: 0 });
}

/** The value of cookie `name` in a `Cookie` header, or null. */
export function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}
