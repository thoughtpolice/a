// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-site request forgery protection for credentials browsers send by
 * themselves (cookies, Basic).
 *
 * @module
 */

import { toBase64Url } from "@celld/sec/jwt";
import { type Context, requestOf, settingsOf } from "./context.ts";
import { checkCookieName } from "./cookies.ts";
import { HttpError, RouterError } from "./errors.ts";
import { timingSafeEqual } from "./timing.ts";
import { optionsRecord } from "./validation.ts";

/** How state-changing requests carrying ambient credentials are checked. */
export interface CsrfOptions {
  /**
   * Other origins whose pages may send such requests (`https://admin.example.com`).
   * Also list this service's own public origin when a proxy in front
   * changes the scheme or host the Worker sees.
   */
  readonly trustedOrigins?: readonly string[];
  /**
   * Also require a double-submit token: the cookie `cookie` must be sent
   * and equal the `header` (or, in an urlencoded form body, the `field`).
   * Mint it with {@link csrfToken}. Default off; the origin check alone
   * stops cross-site requests from current browsers.
   */
  readonly token?: boolean | CsrfTokenOptions;
}

/**
 * A route's CSRF setting: `false` skips the check; `true` runs it even
 * without an ambient credential (a login form); `{ source: "header" }`
 * runs it as the router would but takes the token from the header only,
 * so the body is never read for it (a JSON or multipart route).
 */
export type RouteCsrf = boolean | { readonly source: "header" };

/** Names for the double-submit token. */
export interface CsrfTokenOptions {
  /** Default `__Host-csrf`. */
  readonly cookie?: string;
  /** Default `x-csrf-token`. */
  readonly header?: string;
  /** The form field, for urlencoded bodies; default `_csrf`. */
  readonly field?: string;
}

/** The token settings with their defaults, or null when tokens are off. */
export interface ResolvedCsrf {
  readonly trustedOrigins: ReadonlySet<string>;
  readonly token: Required<CsrfTokenOptions> | null;
}

/** Methods that must not change state, and so are never checked. */
const safeMethods = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
]);
export const SAFE_METHODS: ReadonlySet<string> = Object.freeze({
  get size() {
    return safeMethods.size;
  },
  has: (value: string) => safeMethods.has(value),
  keys: () => safeMethods.keys(),
  values: () => safeMethods.values(),
  entries: () => safeMethods.entries(),
  union: <U>(other: ReadonlySetLike<U>) => safeMethods.union(other),
  intersection: <U>(other: ReadonlySetLike<U>) =>
    safeMethods.intersection(other),
  difference: <U>(other: ReadonlySetLike<U>) => safeMethods.difference(other),
  symmetricDifference: <U>(other: ReadonlySetLike<U>) =>
    safeMethods.symmetricDifference(other),
  isSubsetOf: (other: ReadonlySetLike<unknown>) =>
    safeMethods.isSubsetOf(other),
  isSupersetOf: (other: ReadonlySetLike<unknown>) =>
    safeMethods.isSupersetOf(other),
  isDisjointFrom: (other: ReadonlySetLike<unknown>) =>
    safeMethods.isDisjointFrom(other),
  [Symbol.iterator]: () => safeMethods[Symbol.iterator](),
  forEach: (
    callback: (value: string, value2: string, set: ReadonlySet<string>) => void,
    thisArg?: unknown,
  ) => safeMethods.forEach((v) => callback.call(thisArg, v, v, SAFE_METHODS)),
});

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function onlyKeys(value: object, keys: readonly string[], what: string): void {
  optionsRecord(value, keys, what);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new RouterError(
        `${what} has no option ${JSON.stringify(key)} (it takes ${
          keys.join(", ")
        })`,
      );
    }
  }
}

function tokenNames(
  token: CsrfTokenOptions,
): Required<CsrfTokenOptions> {
  if (typeof token !== "object" || token === null) {
    throw new RouterError("csrf.token must be a boolean or an object");
  }
  onlyKeys(token, ["cookie", "header", "field"], "csrf.token");
  const cookie = token.cookie ?? "__Host-csrf";
  const header = token.header ?? "x-csrf-token";
  const field = token.field ?? "_csrf";
  if (typeof cookie !== "string") {
    throw new RouterError("csrf.token.cookie must be a cookie name");
  }
  try {
    checkCookieName(cookie);
  } catch {
    throw new RouterError(
      `csrf.token.cookie ${JSON.stringify(cookie)} is not a cookie name`,
    );
  }
  if (typeof header !== "string" || !HEADER_NAME.test(header)) {
    throw new RouterError(
      `csrf.token.header ${JSON.stringify(header)} is not a header name`,
    );
  }
  if (typeof field !== "string" || field === "" || field.length > 256) {
    throw new RouterError(
      `csrf.token.field must be a form field name of 1 to 256 characters`,
    );
  }
  return Object.freeze({ cookie, header: header.toLowerCase(), field });
}

/**
 * `options` with defaults, frozen. Throws {@link RouterError} for an
 * option it does not know (a misspelt name would otherwise be ignored),
 * a bad origin, or a bad token name.
 */
export function resolveCsrf(options: CsrfOptions = {}): ResolvedCsrf {
  if (typeof options !== "object" || options === null) {
    throw new RouterError("csrf must be an object or false");
  }
  onlyKeys(options, ["trustedOrigins", "token"], "csrf");
  const listed = options.trustedOrigins ?? [];
  if (
    !Array.isArray(listed) || !listed.every((item) => typeof item === "string")
  ) {
    throw new RouterError("csrf.trustedOrigins must be a list of origins");
  }
  const origins = new Set<string>();
  for (const origin of listed) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new RouterError(
        `CSRF trusted origin ${JSON.stringify(origin)} is not a URL`,
      );
    }
    if (url.origin === "null" || url.origin !== origin.toLowerCase()) {
      throw new RouterError(
        `CSRF trusted origin ${origin} must be scheme://host[:port]`,
      );
    }
    origins.add(url.origin);
  }
  const token = options.token === true
    ? {}
    : options.token === false || options.token === undefined
    ? null
    : options.token;
  return Object.freeze({
    trustedOrigins: origins,
    token: token === null ? null : tokenNames(token),
  });
}

/** Validates a route's `csrf` setting; throws {@link RouterError}. */
export function compileRouteCsrf(value: unknown, where: string): RouteCsrf {
  if (typeof value === "boolean") return value;
  if (typeof value === "object" && value !== null) {
    onlyKeys(value, ["source"], `${where} csrf`);
    if ((value as { source?: unknown }).source === "header") {
      return Object.freeze({ source: "header" });
    }
  }
  throw new RouterError(
    `${where} csrf must be true, false or { source: "header" }`,
  );
}

function refuse(message: string): HttpError {
  return new HttpError(403, message, { code: "csrf" });
}

/**
 * The origin check. With `Sec-Fetch-Site`, only `same-origin` and `none`
 * (the user typed it or used a bookmark) pass, or a trusted `Origin`.
 * Without it, an `Origin` must be this origin or a trusted one, and the
 * opaque `null` never passes. With neither header the request is not from
 * a browser that could have been tricked into sending it, and passes.
 */
export function checkOrigin(c: Context, csrf: ResolvedCsrf): void {
  const origin = requestOf(c).headers.get("origin");
  const trusted = origin !== null && csrf.trustedOrigins.has(origin);
  const site = requestOf(c).headers.get("sec-fetch-site");
  if (site !== null) {
    if (site === "same-origin" || site === "none" || trusted) return;
    throw refuse(`cross-site request refused (Sec-Fetch-Site: ${site})`);
  }
  if (origin === null) return;
  if (origin === c.publicUrl.origin || trusted) return;
  throw refuse(`cross-site request refused (Origin: ${origin})`);
}

/**
 * The token check; `field` is the token from the urlencoded form body, when
 * the route takes it from there and one was sent.
 */
export function checkToken(
  c: Context,
  csrf: ResolvedCsrf,
  field: string | undefined,
): void {
  if (csrf.token === null) return;
  const expected = c.cookie(csrf.token.cookie);
  const sent = requestOf(c).headers.get(csrf.token.header) ?? field ?? null;
  if (expected === undefined || expected === "" || sent === null) {
    throw refuse("the CSRF token is missing");
  }
  if (!timingSafeEqual(expected, sent)) throw refuse("the CSRF token is wrong");
}

/**
 * The request's CSRF token under the router's own token settings (its
 * `csrf.token` cookie name), minting one (32 random bytes) and setting its
 * cookie when there is none; put it in forms as the `field` or send it as
 * the `header`. The cookie is `HttpOnly`, so pages get it from the server.
 * Throws when the router serving the request has no CSRF tokens (a 500),
 * since a token nobody checks protects nothing.
 */
export function csrfToken(c: Context): string {
  const policy = settingsOf(c).csrf;
  if (policy === null || policy.token === null) {
    throw new Error(
      "csrfToken needs a router with CSRF tokens: router({ csrf: { token: true } })",
    );
  }
  const name = policy.token.cookie;
  const existing = c.cookie(name);
  if (existing !== undefined && /^[A-Za-z0-9_-]{43}$/.test(existing)) {
    return existing;
  }
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  c.setCookie(name, token, { sameSite: "Strict" });
  return token;
}
