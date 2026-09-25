// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-site request forgery protection for credentials browsers send by
 * themselves (cookies, Basic).
 *
 * @module
 */

import { toBase64Url } from "@celld/jwt";
import type { Context } from "./context.ts";
import { HttpError, RouterError } from "./errors.ts";
import { timingSafeEqual } from "./timing.ts";

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
   * and equal the `header` (or, in a form body, the `field`). Mint it with
   * {@link csrfToken}. Default off; the origin check alone stops cross-site
   * requests from current browsers.
   */
  readonly token?: boolean | CsrfTokenOptions;
}

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
export const SAFE_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "TRACE",
]);

/** `options` with defaults; throws {@link RouterError} for a bad origin. */
export function resolveCsrf(options: CsrfOptions = {}): ResolvedCsrf {
  const origins = new Set<string>();
  for (const origin of options.trustedOrigins ?? []) {
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
  return {
    trustedOrigins: origins,
    token: token === null ? null : {
      cookie: token.cookie ?? "__Host-csrf",
      header: token.header ?? "x-csrf-token",
      field: token.field ?? "_csrf",
    },
  };
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
  const origin = c.req.headers.get("origin");
  const trusted = origin !== null && csrf.trustedOrigins.has(origin);
  const site = c.req.headers.get("sec-fetch-site");
  if (site !== null) {
    if (site === "same-origin" || site === "none" || trusted) return;
    throw refuse(`cross-site request refused (Sec-Fetch-Site: ${site})`);
  }
  if (origin === null) return;
  if (origin === c.url.origin || trusted) return;
  throw refuse(`cross-site request refused (Origin: ${origin})`);
}

/** The token check; `form` is the parsed form body, when there is one. */
export function checkToken(
  c: Context,
  csrf: ResolvedCsrf,
  form: Readonly<Record<string, unknown>> | undefined,
): void {
  if (csrf.token === null) return;
  const expected = c.cookie(csrf.token.cookie);
  const field = form?.[csrf.token.field];
  const sent = c.req.headers.get(csrf.token.header) ??
    (typeof field === "string" ? field : null);
  if (expected === undefined || expected === "" || sent === null) {
    throw refuse("the CSRF token is missing");
  }
  if (!timingSafeEqual(expected, sent)) throw refuse("the CSRF token is wrong");
}

/**
 * The request's CSRF token, minting one (32 random bytes) and setting its
 * cookie when there is none; put it in forms as the `field` or send it as
 * the `header`. The cookie is `HttpOnly`, so pages get it from the server.
 */
export function csrfToken(c: Context, options: CsrfTokenOptions = {}): string {
  const name = options.cookie ?? "__Host-csrf";
  const existing = c.cookie(name);
  if (existing !== undefined && /^[A-Za-z0-9_-]{43}$/.test(existing)) {
    return existing;
  }
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  c.setCookie(name, token, { sameSite: "Strict" });
  return token;
}
