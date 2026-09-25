// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Small pieces every part of the library shares: random values, hashes,
 * constant-time comparison, form and Basic encoding, JSON responses, the
 * clock and `fetch` types, and loopback detection.
 *
 * @module
 */

import { parseJsonBounded, readTextBounded } from "@celld/core/bounds";
import { JwtError, toBase64Url } from "@celld/sec/jwt";
import { contains, parseIp } from "@celld/core/ip";

/** Fetches like the global `fetch`. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Milliseconds since the epoch, like `Date.now`. */
export type Clock = () => number;

/** The global `fetch`, looked up when called so tests can replace it. */
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/**
 * Rethrows `cause` when it is `@celld/sec/jwt`'s `runtime_unsupported`: the
 * runtime cannot check the signature at all, so
 * the server is misconfigured and must fail loudly (a router 503) instead of
 * refusing the client's credential as if it were bad.
 */
export function rethrowRuntimeUnsupported(cause: unknown): void {
  if (cause instanceof JwtError && cause.code === "runtime_unsupported") {
    throw cause;
  }
}

/** `Date.now`, looked up when called. */
export const defaultClock: Clock = () => Date.now();

const encoder = new TextEncoder();

/** `bytes` random bytes as unpadded base64url; 32 bytes (256 bits) by default. */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The SHA-256 of `text` (as UTF-8), in unpadded base64url. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return toBase64Url(new Uint8Array(digest));
}

/**
 * Whether two strings are equal, in time that depends only on their
 * lengths, not on where they first differ.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/** `application/x-www-form-urlencoded` encoding of one value. */
export function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

function formDecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, " "));
}

/**
 * An HTTP Basic `Authorization` value for client credentials, with both
 * parts form-encoded first as RFC 6749 section 2.3.1 requires.
 */
export function basicAuthorization(clientId: string, secret: string): string {
  const pair = `${formEncode(clientId)}:${formEncode(secret)}`;
  const bytes = encoder.encode(pair);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/** The client id and secret of a Basic `Authorization` value, or null. */
export function parseBasicAuthorization(
  header: string | null,
): { clientId: string; secret: string } | null {
  if (header === null) return null;
  const match = /^Basic[ \t]+([A-Za-z0-9+/]+=*)[ \t]*$/i.exec(header);
  if (match === null) return null;
  try {
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const colon = text.indexOf(":");
    if (colon < 0) return null;
    return {
      clientId: formDecode(text.slice(0, colon)),
      secret: formDecode(text.slice(colon + 1)),
    };
  } catch {
    return null;
  }
}

/** Whether `value` is a JSON object (not an array or null). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Headers every response carrying credentials gets (RFC 6749 section 5.1). */
export const NO_STORE: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "no-store",
  pragma: "no-cache",
});

/** A JSON response. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: HeadersInit = {},
): Response {
  const out = new Headers(headers);
  out.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: out });
}

/** The most bytes {@link readJsonObject} reads by default: 256 KiB. */
export const JSON_RESPONSE_MAX_BYTES = 256 * 1024;

/**
 * A response's body as a JSON object, or null when it is not one. The body
 * is read as a stream and abandoned (cancelled) past `maxBytes`, whatever
 * `Content-Length` says, and parsed with depth and size limits and no
 * duplicate or prototype keys; an oversized body is null too.
 */
export async function readJsonObject(
  response: Response,
  maxBytes = JSON_RESPONSE_MAX_BYTES,
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readTextBounded(response, { maxBytes });
  } catch {
    return null;
  }
  try {
    const value = parseJsonBounded(text, {
      maxDepth: 32,
      maxKeys: 1000,
      maxItems: 10_000,
    });
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

const LOOPBACK_V4 = "127.0.0.0/8";

/**
 * Whether a URL host is loopback: `localhost`, a `*.localhost` name
 * (RFC 6761), `127.0.0.0/8`, or `[::1]`.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const bare = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  const address = parseIp(bare);
  if (address === null) return false;
  if (address.bits === 32) return contains(LOOPBACK_V4, address);
  const v4 = address.toIpv4();
  if (v4 !== null && address.isIpv4Mapped()) return contains(LOOPBACK_V4, v4);
  return address.toString() === "::1";
}

/** Space-separated scope values, without empties or duplicates. */
export function parseScope(scope: string | null | undefined): string[] {
  if (scope === null || scope === undefined) return [];
  return [...new Set(scope.split(" ").filter((part) => part !== ""))];
}

/** Scope values as one space-separated string. */
export function formatScope(scopes: Iterable<string>): string {
  return [...new Set(scopes)].join(" ");
}

/**
 * Whether a scope token is well formed (RFC 6749 section 3.3): one or more
 * printable ASCII characters other than space, `"` and `\`.
 */
export function isScopeToken(scope: string): boolean {
  return /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope);
}

/** Whether every scope in `required` is in `granted`. */
export function hasScopes(
  granted: readonly string[],
  required: readonly string[],
): boolean {
  return required.every((scope) => granted.includes(scope));
}

/** Seconds since the epoch, rounded down. */
export function epochSeconds(now: Clock): number {
  return Math.floor(now() / 1000);
}

/** Whether `value` is an array or an object with no prototype but Object's. */
function isPlainContainer(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Whether a plain object has a method or accessor: it owns state (a store). */
function hasBehaviour(value: object): boolean {
  return Object.values(Object.getOwnPropertyDescriptors(value)).some((
    descriptor,
  ) =>
    descriptor.get !== undefined || descriptor.set !== undefined ||
    typeof descriptor.value === "function"
  );
}

/**
 * Whether no array or plain data object reachable from `value` can
 * change: each is frozen, all the way down. Objects that carry behaviour
 * end the walk, as {@link snapshot} keeps them anyway.
 */
function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (!isPlainContainer(value)) return true;
  if (!Array.isArray(value) && hasBehaviour(value)) return true;
  if (!Object.isFrozen(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.values(value).every((item) => deeplyFrozen(item, seen));
}

/** Sets `copy[name]` as an own data member, even for `__proto__`. */
function defineMember(copy: object, name: string, value: unknown): void {
  Object.defineProperty(copy, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * A frozen copy of configuration `value`, taken when a constructor gets
 * it so that changing the caller's objects afterwards changes nothing:
 * arrays and plain data objects are copied and frozen, recursively, frozen
 * ones included unless everything inside them is frozen too (a frozen map
 * of live lists is copied). Objects that carry behaviour are kept as they
 * are, since they own their state: functions, class instances (key sets,
 * `CryptoKey`s, nonce issuers), typed arrays, and plain objects with a
 * method or accessor (stores); so are deeply frozen values (signing
 * keys), which cannot change. A constructor whose options mix data and
 * callbacks in one object copies the data members of that object itself.
 * Members are defined, not assigned, so an own `__proto__` key stays a
 * data member on runtimes with the `__proto__` accessor.
 */
export function snapshot<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (!isPlainContainer(value)) return value;
  if (Array.isArray(value)) {
    if (deeplyFrozen(value)) return value;
    return Object.freeze(value.map((item) => snapshot(item))) as T;
  }
  if (hasBehaviour(value) || deeplyFrozen(value)) return value;
  const copy: Record<string, unknown> = Object.getPrototypeOf(value) === null
    ? Object.create(null)
    : {};
  for (const [name, item] of Object.entries(value)) {
    defineMember(copy, name, snapshot(item));
  }
  return Object.freeze(copy) as T;
}

/**
 * A frozen copy of a constructor's options object: each member through
 * {@link snapshot}, so callbacks stay as given and data is copied, and the
 * options object itself frozen.
 */
export function snapshotOptions<T extends object>(options: T): T {
  const copy: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(options)) {
    defineMember(copy, name, snapshot(item));
  }
  return Object.freeze(copy) as T;
}
