// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Cookies: parsing `Cookie`, writing `Set-Cookie` with safe defaults, and
 * a {@link CookieKeyring} that signs (HMAC-SHA256) or encrypts (AES-GCM)
 * values with rotating keys.
 *
 * @module
 */

import { fromBase64Url, toBase64Url } from "@celld/sec/jwt";
import { type Duration, durationMs } from "./duration.ts";
import { RouterError } from "./errors.ts";
import { optionsRecord, optionType } from "./validation.ts";
import { utf8Length } from "@celld/core/bounds";

/**
 * `Set-Cookie` attributes. The defaults are `HttpOnly; Secure;
 * SameSite=Lax; Path=/`: scripts cannot read the cookie, it is only sent
 * over https, and other sites' subresource requests and POSTs do not carry
 * it.
 */
export interface CookieOptions {
  /** Default true. */
  readonly httpOnly?: boolean;
  /** Default true; `__Secure-` and `__Host-` names and `SameSite=None` require it. */
  readonly secure?: boolean;
  /** Default `"Lax"`. */
  readonly sameSite?: "Strict" | "Lax" | "None";
  /** Default `"/"`; a `__Host-` name requires `/`. */
  readonly path?: string;
  /** No default (host-only); a `__Host-` name may not have one. */
  readonly domain?: string;
  /**
   * `Max-Age`, as seconds or an ISO 8601 duration; at most 400 days
   * ({@link MAX_COOKIE_AGE_MS}), the most a browser keeps a cookie (RFC
   * 6265bis), else a {@link RouterError}.
   */
  readonly maxAge?: Duration;
  /**
   * `Expires`: a valid `Date` (else a {@link RouterError}); one more than
   * 400 days away is written as 400 days from now.
   */
  readonly expires?: Date;
  /** CHIPS `Partitioned`; requires `Secure`. */
  readonly partitioned?: boolean;
}

/** The longest a cookie may live: 400 days (RFC 6265bis section 5.5). */
export const MAX_COOKIE_AGE_MS = 400 * 86_400_000;

/** `maxAge` in milliseconds, within 0 to 400 days; throws {@link RouterError}. */
export function cookieMaxAgeMs(maxAge: Duration, what = "maxAge"): number {
  return durationMs(maxAge, what, {
    maxMs: MAX_COOKIE_AGE_MS,
    maxName: "400 days",
  });
}

/** Throws {@link RouterError} unless `expires` is a valid `Date`. */
export function checkExpires(expires: unknown, what = "expires"): Date {
  if (!(expires instanceof Date) || !Number.isFinite(expires.getTime())) {
    throw new RouterError(`${what} must be a valid Date`);
  }
  return expires;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const OCTETS = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
const ATTRIBUTE = /^[\x20-\x3A\x3C-\x7E]*$/;

/** Throws unless `name` is a cookie name (an RFC 9110 token). */
export function checkCookieName(name: string): void {
  if (typeof name !== "string" || name.length > 256 || !TOKEN.test(name)) {
    throw new RouterError(`not a cookie name: ${JSON.stringify(name)}`);
  }
}

/**
 * A `Set-Cookie` value. `value` must already be cookie-safe (no spaces,
 * quotes, commas, semicolons or backslashes: encode it first, as the
 * keyring does). Throws {@link RouterError} for a bad name or value and for
 * attributes the prefixes forbid.
 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  optionsRecord(options, [
    "httpOnly",
    "secure",
    "sameSite",
    "path",
    "domain",
    "maxAge",
    "expires",
    "partitioned",
  ], "cookie options");
  for (const key of ["httpOnly", "secure", "partitioned"] as const) {
    optionType(options[key], "boolean", `cookie ${key}`);
  }
  if (
    options.sameSite !== undefined &&
    !["Strict", "Lax", "None"].includes(options.sameSite)
  ) throw new RouterError("invalid cookie SameSite");
  checkCookieName(name);
  if (typeof value !== "string" || value.length > 3800 || !OCTETS.test(value)) {
    throw new RouterError(
      `the value of cookie ${name} has characters a cookie cannot carry; encode it`,
    );
  }
  const secure = options.secure ?? true;
  const path = options.path ?? "/";
  const sameSite = options.sameSite ?? "Lax";
  const lower = name.toLowerCase();
  if (
    (lower.startsWith("__secure-") || lower.startsWith("__host-")) && !secure
  ) {
    throw new RouterError(`cookie ${name} needs Secure because of its prefix`);
  }
  if (
    lower.startsWith("__host-") &&
    (path !== "/" || options.domain !== undefined)
  ) {
    throw new RouterError(
      `cookie ${name} needs Path=/ and no Domain (__Host-)`,
    );
  }
  if (sameSite === "None" && !secure) {
    throw new RouterError(
      `cookie ${name} is SameSite=None, which needs Secure`,
    );
  }
  if (options.partitioned && !secure) {
    throw new RouterError(`cookie ${name} is Partitioned, which needs Secure`);
  }
  for (const [label, text] of [["path", path], ["domain", options.domain]]) {
    if (
      text !== undefined &&
      (typeof text !== "string" || text.length > 1024 || !ATTRIBUTE.test(text))
    ) {
      throw new RouterError(`cookie ${name} has a bad ${label}`);
    }
  }
  if (!path.startsWith("/")) {
    throw new RouterError("cookie path must be absolute");
  }
  if (
    options.domain !== undefined &&
    !/^\.?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/.test(options.domain)
  ) throw new RouterError("invalid cookie domain");
  const parts = [`${name}=${value}`];
  if (options.maxAge !== undefined) {
    const seconds = Math.floor(cookieMaxAgeMs(options.maxAge) / 1000);
    parts.push(`Max-Age=${seconds}`);
  }
  if (options.expires !== undefined) {
    const at = checkExpires(options.expires).getTime();
    const latest = Date.now() + MAX_COOKIE_AGE_MS;
    parts.push(`Expires=${new Date(Math.min(at, latest)).toUTCString()}`);
  }
  if (options.domain !== undefined) parts.push(`Domain=${options.domain}`);
  parts.push(`Path=${path}`);
  if (secure) parts.push("Secure");
  if (options.httpOnly ?? true) parts.push("HttpOnly");
  parts.push(`SameSite=${sameSite}`);
  if (options.partitioned) parts.push("Partitioned");
  const output = parts.join("; ");
  if (output.length > 4096) {
    throw new RouterError("Set-Cookie exceeds the browser size limit");
  }
  return output;
}

/**
 * The cookies in a `Cookie` header, by name. When a name repeats, the
 * first wins (browsers send the most specific path first). Values are as
 * sent, not decoded; surrounding double quotes are removed.
 */
export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (header === null) return out;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    let value = pair.slice(index + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (name !== "" && !out.has(name)) out.set(name, value);
  }
  return out;
}

/** A secret for a {@link CookieKeyring}: at least 32 bytes, text or bytes. */
export interface CookieKey {
  /** Short and unique within the ring (`[A-Za-z0-9_-]`, 1 to 32 characters). */
  readonly id: string;
  readonly secret: string | Uint8Array;
}

/** A value that verified or decrypted. */
export interface OpenedCookie {
  readonly value: string;
  /** The id of the key that verified it. */
  readonly key: string;
  /** Whether that key is not the current one: set the cookie again to rotate it. */
  readonly stale: boolean;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const MIN_SECRET = 32;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface Derived {
  readonly mac: CryptoKey;
  readonly enc: CryptoKey;
}

async function derive(secret: Uint8Array): Promise<Derived> {
  const root = await crypto.subtle.importKey(
    "raw",
    secret as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expand = async (label: string) =>
    await crypto.subtle.sign("HMAC", root, encoder.encode(label));
  const [macBytes, encBytes] = await Promise.all([
    expand("celld-router cookie mac v1"),
    expand("celld-router cookie enc v1"),
  ]);
  const [mac, enc] = await Promise.all([
    crypto.subtle.importKey(
      "raw",
      macBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
    crypto.subtle.importKey("raw", encBytes, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]),
  ]);
  return { mac, enc };
}

/**
 * Keys for signed and encrypted cookies, newest first. The first key signs
 * and encrypts; every key verifies and decrypts, so a secret can be
 * rotated by putting the new one first and dropping the old one once its
 * cookies have expired. {@link OpenedCookie.stale} says a cookie was made
 * with an older key.
 *
 * Each secret is split into an HMAC-SHA256 key and an AES-256-GCM key.
 * The cookie's name is bound into the MAC and the GCM associated data, so
 * a value made for one cookie is refused under another name.
 *
 * - signed: `s1.<key id>.<value>.<mac>`: readable by the client, not
 *   changeable;
 * - sealed: `e1.<key id>.<iv>.<ciphertext>`: neither.
 */
export class CookieKeyring {
  readonly #ids: readonly string[];
  readonly #keys: ReadonlyMap<string, Promise<Derived>>;

  /** Throws {@link RouterError} for no keys, a repeated or bad id, or a short secret. */
  constructor(keys: readonly CookieKey[]) {
    if (
      !Array.isArray(keys) || keys.length === 0 || keys.length > 8 ||
      Object.getPrototypeOf(keys) !== Array.prototype ||
      Reflect.ownKeys(keys).length !== keys.length + 1
    ) {
      throw new RouterError("a cookie keyring needs a key");
    }
    const copied = new Map<string, Uint8Array<ArrayBuffer>>();
    for (let index = 0; index < keys.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(keys, String(index));
      if (!entry?.enumerable || !("value" in entry)) {
        throw new RouterError("cookie keys must be a dense data array");
      }
      const key = entry.value as CookieKey;
      optionsRecord(key, ["id", "secret"], "cookie key");
      if (typeof key.id !== "string" || !KEY_ID.test(key.id)) {
        throw new RouterError(`bad cookie key id ${JSON.stringify(key.id)}`);
      }
      if (copied.has(key.id)) {
        throw new RouterError(`cookie key id ${key.id} repeats`);
      }
      if (
        typeof key.secret !== "string" && !(key.secret instanceof Uint8Array)
      ) throw new RouterError("cookie secret must be text or bytes");
      if (key.secret.length > 4096) {
        throw new RouterError("cookie secret is too large");
      }
      const secret = typeof key.secret === "string"
        ? encoder.encode(key.secret)
        : new Uint8Array(key.secret);
      if (secret.length < MIN_SECRET) {
        throw new RouterError(
          `cookie key ${key.id} needs at least ${MIN_SECRET} bytes of secret`,
        );
      }
      copied.set(key.id, secret);
    }
    this.#ids = Object.freeze([...copied.keys()]);
    this.#keys = new Map([...copied].map(([id, bytes]) => [id, derive(bytes)]));
  }

  /** The id of the key that signs and encrypts. */
  get current(): string {
    return this.#ids[0];
  }

  /** `value` signed for the cookie `name`. */
  async sign(name: string, value: string): Promise<string> {
    checkCookieName(name);
    if (
      typeof value !== "string" || value.length > 2700 ||
      utf8Length(value) > 2700
    ) throw new RouterError("cookie plaintext exceeds size limit");
    const id = this.current;
    const body = `s1.${id}.${toBase64Url(value)}`;
    const { mac } = await this.#keys.get(id)!;
    const tag = await crypto.subtle.sign("HMAC", mac, signed(name, body));
    return `${body}.${toBase64Url(new Uint8Array(tag))}`;
  }

  /** The value of a {@link sign}ed cookie, or null if it is not one of ours. */
  async verify(name: string, text: string): Promise<OpenedCookie | null> {
    checkCookieName(name);
    if (typeof text !== "string" || text.length > 3800) return null;
    const parts = text.split(".");
    if (parts.length !== 4 || parts[0] !== "s1") return null;
    const [, id, payload, tag] = parts;
    const keys = this.#keys.get(id);
    const tagBytes = fromBase64Url(tag);
    const valueBytes = fromBase64Url(payload);
    if (keys === undefined || tagBytes === null || valueBytes === null) {
      return null;
    }
    const { mac } = await keys;
    const body = `s1.${id}.${payload}`;
    if (
      !await crypto.subtle.verify("HMAC", mac, tagBytes, signed(name, body))
    ) {
      return null;
    }
    const value = decode(valueBytes);
    return value === null ? null : this.#opened(value, id);
  }

  /** `value` encrypted for the cookie `name`. */
  async seal(name: string, value: string): Promise<string> {
    checkCookieName(name);
    if (
      typeof value !== "string" || value.length > 2700 ||
      utf8Length(value) > 2700
    ) throw new RouterError("cookie plaintext exceeds size limit");
    const id = this.current;
    const { enc } = await this.#keys.get(id)!;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: signed(name, `e1.${id}`) },
      enc,
      encoder.encode(value),
    );
    return `e1.${id}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(data))}`;
  }

  /** The value of a {@link seal}ed cookie, or null if it is not one of ours. */
  async unseal(name: string, text: string): Promise<OpenedCookie | null> {
    checkCookieName(name);
    if (typeof text !== "string" || text.length > 3800) return null;
    const parts = text.split(".");
    if (parts.length !== 4 || parts[0] !== "e1") return null;
    const [, id, ivText, dataText] = parts;
    const keys = this.#keys.get(id);
    const iv = fromBase64Url(ivText);
    const data = fromBase64Url(dataText);
    if (
      keys === undefined || iv === null || data === null || iv.length !== 12
    ) {
      return null;
    }
    const { enc } = await keys;
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: signed(name, `e1.${id}`) },
        enc,
        data,
      );
    } catch {
      return null;
    }
    const value = decode(new Uint8Array(plain));
    return value === null ? null : this.#opened(value, id);
  }

  #opened(value: string, id: string): OpenedCookie {
    return { value, key: id, stale: id !== this.current };
  }
}

function signed(name: string, body: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${name}\n${body}`);
}

function decode(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** A {@link CookieKeyring} over `keys`, newest first. */
export function cookieKeys(keys: readonly CookieKey[]): CookieKeyring {
  return new CookieKeyring(keys);
}
