// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Small pieces the subpaths share: JSON and redirect responses, media
 * types, configuration snapshots, and the default clock and fetch.
 * Network reads are not here: each goes through `@celld/http/egress`'s
 * bounded fetch where it is made.
 *
 * @module
 */

import { JwtError } from "@celld/sec/jwt";
import { finite, strictRecord } from "@celld/core/bounds";
import type { Clock, FetchLike } from "@celld/sec/oauth";
import { isSigningKey, redirectUriProblem } from "@celld/sec/oauth/server";

/**
 * Rethrows `cause` when it is `@celld/sec/jwt`'s `runtime_unsupported`: the
 * runtime cannot check the signature at all, which is the server's
 * misconfiguration, not a bad token, so it must not be reported as one.
 */
export function rethrowRuntimeUnsupported(cause: unknown): void {
  if (cause instanceof JwtError && cause.code === "runtime_unsupported") {
    throw cause;
  }
}

/** `Date.now`, looked up when called. */
export const defaultClock: Clock = () => Date.now();

/** The global `fetch`, looked up when called so tests can replace it. */
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** Headers for responses that carry credentials or personal data. */
export const NO_STORE: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  pragma: "no-cache",
};

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

/** A plain-text response that is never cached. */
export function textResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE },
  });
}

/** A 303 to `location` that is never cached. */
export function redirectResponse(
  location: string,
  headers: HeadersInit = {},
): Response {
  const out = new Headers(headers);
  out.set("location", location);
  for (const [name, value] of Object.entries(NO_STORE)) out.set(name, value);
  return new Response(null, { status: 303, headers: out });
}

/** Whether `value` is a JSON object (not an array or null). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Epoch seconds, rounded down. */
export function epochSeconds(now: Clock): number {
  return Math.floor(
    finite(now(), { name: "clock", min: 0, max: 8.64e15 }) / 1000,
  );
}

/** Whether `value` is an array of strings. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}

/** The values of `aud`, a string or a list. */
export function audiences(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return isStringArray(value) ? value : [];
}

/** Whether a media type (from a `Content-Type`) is `expected`, ignoring parameters and case. */
export function isMediaType(type: string, expected: string): boolean {
  return type.split(";")[0].trim().toLowerCase() === expected;
}

/**
 * A frozen copy of configuration `value`, taken when a constructor gets
 * it so that changing the caller's objects afterwards changes nothing:
 * arrays and plain data objects are copied and frozen, recursively.
 * Objects that carry behaviour are kept as they are, since they own their
 * state: functions, class instances (clients, key sets, sealers), typed
 * arrays, objects already frozen (signing keys), and plain objects with a
 * method or accessor (stores, lookups). A constructor whose options mix
 * data and callbacks in one object copies that object's data members
 * itself, with {@link snapshotOptions}.
 */
export function snapshot<T>(value: T): T {
  if (isSigningKey(value)) return value;
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => snapshot(item))) as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const behaviour = Object.values(descriptors).some((descriptor) =>
    descriptor.get !== undefined || descriptor.set !== undefined ||
    typeof descriptor.value === "function"
  );
  if (behaviour) return value;
  const copy: Record<string, unknown> = proto === null
    ? Object.create(null)
    : {};
  for (const [name, item] of Object.entries(value)) {
    defineData(copy, name, snapshot(item));
  }
  return Object.freeze(copy) as T;
}

/** Validate endpoint path overrides before concatenating with an issuer base. */
export function checkPaths(
  base: string,
  paths: object | undefined,
  defaults: Record<string, string>,
): void {
  if (paths !== undefined) {
    strictRecord(paths, Object.keys(defaults), "endpoint paths");
  }
  const used = new Set<string>();
  for (const [name, fallback] of Object.entries(defaults)) {
    const path = (paths as Record<string, unknown> | undefined)?.[name] ??
      fallback;
    if (
      typeof path !== "string" || !/^\/(?!\/)[^?#\\]*$/.test(path) ||
      [...path].some((char) =>
        char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127
      )
    ) throw new TypeError("endpoint paths must be canonical absolute paths");
    const url = new URL(base + path);
    if (
      url.origin !== new URL(base).origin ||
      url.pathname !== new URL(base).pathname.replace(/\/$/, "") + path ||
      used.has(url.href)
    ) throw new TypeError("endpoint paths must be distinct and canonical");
    used.add(url.href);
  }
}

/**
 * Sets `copy[name]` as an own data property. An assignment would call
 * the `__proto__` setter (Workers and browsers have it) for an own
 * `__proto__` key, as `JSON.parse` makes, and set the copy's prototype.
 */
function defineData(
  copy: Record<string, unknown>,
  name: string,
  value: unknown,
): void {
  Object.defineProperty(copy, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * A frozen copy of an options object: each member through
 * {@link snapshot}, and the object itself frozen.
 */
export function snapshotOptions<T extends object>(options: T): T {
  const copy: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(options)) {
    defineData(copy, name, snapshot(item));
  }
  return Object.freeze(copy) as T;
}

/**
 * Why a client's `post_logout_redirect_uris` cannot be used, or null:
 * each must pass `@celld/sec/oauth/server`'s `redirectUriProblem` for the
 * client's `application_type`.
 */
export function postLogoutProblem(client: object): string | null {
  const record = client as {
    readonly post_logout_redirect_uris?: unknown;
    readonly application_type?: unknown;
  };
  const uris = record.post_logout_redirect_uris;
  if (uris === undefined) return null;
  if (!Array.isArray(uris) || !uris.every((uri) => typeof uri === "string")) {
    return "post_logout_redirect_uris must be a list of URIs";
  }
  const type = record.application_type === "native" ? "native" : "web";
  for (const uri of uris) {
    const problem = redirectUriProblem(uri, type);
    if (problem !== null) {
      return `post_logout_redirect_uri ${uri} ${problem}`;
    }
  }
  return null;
}

/**
 * The fewest distinct byte values an operator secret may hold. A floor
 * that catches `"a".repeat(32)` or `"changeme"` repeated, not an entropy
 * measure: 32 random bytes hold about 30, a 64-character hex string at
 * most 16.
 */
export const SECRET_MIN_DISTINCT_BYTES = 12;

/** Snapshot a bounded ordinary dense rotation list before invoking any iterator/crypto. */
export function rotationSecrets(
  secret: string | Uint8Array,
  previous: unknown,
  what: string,
): Uint8Array[] {
  const old = previous === undefined ? [] : previous;
  if (
    !Array.isArray(old) || Object.getPrototypeOf(old) !== Array.prototype ||
    old.length > 3
  ) {
    throw new TypeError(
      "previous must be an ordinary array of at most three keys",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(old);
  if (
    Reflect.ownKeys(old).length !== old.length + 1 ||
    Reflect.ownKeys(old).some((key) => typeof key !== "string") ||
    Array.from({ length: old.length }, (_, index) => descriptors[String(index)])
      .some((descriptor) =>
        descriptor === undefined || !Object.hasOwn(descriptor, "value")
      )
  ) throw new TypeError("previous must be a dense data-only key array");
  return [
    Uint8Array.from(secretBytes(secret, what)),
    ...Array.from(
      { length: old.length },
      (_, index) =>
        Uint8Array.from(secretBytes(descriptors[String(index)].value, what)),
    ),
  ];
}

/**
 * The bytes of operator secret `secret` (a string is UTF-8): at least 32
 * bytes and {@link SECRET_MIN_DISTINCT_BYTES} distinct values, else a
 * `TypeError` naming `what`. Use 32 random bytes (base64url).
 */
export function secretBytes(
  secret: string | Uint8Array,
  what: string,
): Uint8Array {
  const bytes = typeof secret === "string"
    ? new TextEncoder().encode(secret)
    : secret;
  if (!(bytes instanceof Uint8Array) || bytes.length < 32) {
    throw new TypeError(`${what} needs at least 32 bytes`);
  }
  if (new Set(bytes).size < SECRET_MIN_DISTINCT_BYTES) {
    throw new TypeError(
      `${what} is not random: use 32 random bytes (base64url)`,
    );
  }
  return bytes;
}
